#!/usr/bin/env node
// zcouncil-cli — local bridge that lets zcouncil.com use your ChatGPT plan
// for the GPT council member.
//
// What it does, in one paragraph:
//
//   You sign in on zcouncil.com. You run this script on your laptop. It
//   opens a WebSocket to api.zcouncil.com/bridge with your zcouncil
//   session token. When the council needs an answer from GPT, the worker
//   sends a request down the WebSocket. This script reads your ChatGPT
//   OAuth token from ~/.codex/auth.json (the file the official OpenAI
//   Codex CLI maintains), calls chatgpt.com/backend-api from your IP,
//   streams the reply back. Your token never touches our servers.
//
// One ESM file, no dependencies, no node_modules. Requires Node 22+
// (for the built-in WebSocket global).
//
// Source + issues: https://github.com/sshkeda/zcouncil-cli

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline/promises"

const CLI_VERSION = "0.3.0"
const PROTOCOL_VERSION = 1
const SUPPORTED_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]
const DEFAULT_BRIDGE_URL = "wss://api.zcouncil.com/bridge"
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
const AUTH_PATH = join(homedir(), ".codex", "auth.json")
const TOKEN_PATH = join(homedir(), ".zcouncil", "token")
// Deep link — lands on the API tokens tab with the "New token" dialog
// already open. Falls through OAuth correctly because the action is a
// real query param (survives Google's callback), not a URL fragment.
const PROD_SETTINGS_URL = "https://zcouncil.com/chat?action=new-token"

// Derive the web origin from the bridge URL so `--bridge ws://localhost:8787/bridge`
// points the user at http://localhost:4321 (the local astro dev server)
// instead of prod. For prod (api.zcouncil.com), strip the `api.` subdomain;
// for anything else (preview deploys, custom hosts), fall back to prod.
function settingsUrl(bridgeUrl) {
  try {
    const u = new URL(bridgeUrl.replace(/^ws/, "http"))
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return "http://localhost:4321/chat?action=new-token"
    }
    if (u.hostname === "api.zcouncil.com") return PROD_SETTINGS_URL
    return PROD_SETTINGS_URL
  } catch {
    return PROD_SETTINGS_URL
  }
}
const PLACEHOLDER_TOKEN = "YOUR_ZCOUNCIL_TOKEN"
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

// ─── version + arg parsing ──────────────────────────────────────────────────

const [nodeMajor] = process.versions.node.split(".").map(Number)
if (nodeMajor < 22) {
  console.error(
    `error: zcouncil-cli needs Node 22+ for the built-in WebSocket global. You're on ${process.versions.node}.`,
  )
  process.exit(2)
}

function logout() {
  if (!existsSync(TOKEN_PATH)) {
    console.log("Already logged out (no saved token).")
    process.exit(0)
  }
  try {
    unlinkSync(TOKEN_PATH)
    console.log(`Logged out. Cleared saved token at ${TOKEN_PATH}.`)
    process.exit(0)
  } catch (err) {
    console.error(`Couldn't clear ${TOKEN_PATH}: ${err.message}`)
    process.exit(1)
  }
}

function parseArgs(argv) {
  const args = argv.slice(2)
  // Subcommand: `logout` wipes the saved token and exits. Checked
  // anywhere in args (not just args[0]) so both `zcouncil-cli logout`
  // and `zcouncil-cli --bridge <u> logout` work the same way.
  if (args.includes("logout")) logout()
  let bridgeUrl = process.env.ZCOUNCIL_BRIDGE_URL ?? DEFAULT_BRIDGE_URL
  let token = process.env.ZCOUNCIL_TOKEN ?? ""
  let tokenFromFlag = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--token" && args[i + 1]) {
      token = args[++i]
      tokenFromFlag = true
    } else if (a === "--bridge" && args[i + 1]) {
      bridgeUrl = args[++i]
    } else if (a === "--help" || a === "-h") {
      printHelp()
      process.exit(0)
    } else if (a === "--version" || a === "-v") {
      console.log(CLI_VERSION)
      process.exit(0)
    }
  }
  // No explicit token? Fall back to the saved one from the last run, so
  // `npx -y zcouncil-cli` alone works on every reconnect.
  let tokenFromFile = false
  if (!token && existsSync(TOKEN_PATH)) {
    try {
      const saved = readFileSync(TOKEN_PATH, "utf8").trim()
      if (saved) {
        token = saved
        tokenFromFile = true
      }
    } catch (err) {
      console.warn(`Couldn't read saved token at ${TOKEN_PATH}: ${err.message}`)
    }
  }
  // Token may be empty here — main() prompts interactively in that case.
  // We only catch the shell-mangled placeholder (`<YOUR_ZCOUNCIL_TOKEN>`
  // becomes `no such file or directory` in zsh; `YOUR_ZCOUNCIL_TOKEN` as
  // a literal string silently 401s later) when explicitly passed, so the
  // user gets a link instead of a useless error.
  if (token && (token === PLACEHOLDER_TOKEN || /^<.+>$/.test(token))) {
    console.error(`"${token}" is the placeholder, not a real token.`)
    console.error(`Create one: ${settingsUrl(bridgeUrl)}`)
    process.exit(2)
  }
  return { bridgeUrl, token, tokenFromFlag, tokenFromFile }
}

// Interactive prompt for a missing token. Prints the deep link (derived
// from the bridge URL, so local dev points at the local web server),
// waits for the user to paste the token and hit enter, then saves it so
// the next run auto-detects. Returns the trimmed token (possibly empty
// if the user just hit enter).
async function promptForToken(bridgeUrl) {
  console.log("")
  console.log("No zcouncil token found.")
  console.log("")
  console.log(`1. Create one: ${settingsUrl(bridgeUrl)}`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question("2. Paste it here: ")
    return answer.trim()
  } finally {
    rl.close()
  }
}

// Server auth check: returns "valid" / "invalid" / "unreachable".
// Lets the CLI distinguish a revoked token (exit immediately with the
// deep link) from a transient network blip (keep retrying) — the WS
// handshake alone reports both as close code 1006.
async function checkToken(opts) {
  const url = opts.bridgeUrl.replace(/^ws/, "http").replace(/\/bridge$/, "/bridge/check-token")
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: opts.token }),
    })
    if (res.status === 401) return "invalid"
    if (res.ok) return "valid"
    return "unreachable"
  } catch {
    return "unreachable"
  }
}

function exitOnInvalidToken(opts) {
  console.error("")
  console.error("That token isn't valid anymore (deleted, rotated, or never existed).")
  console.error(`Create a new one: ${settingsUrl(opts.bridgeUrl)}`)
  if (opts.tokenFromFile) {
    try {
      unlinkSync(TOKEN_PATH)
      console.error(`Cleared the stale saved token.`)
    } catch {
      // ignore
    }
  }
  process.exit(2)
}

// Write the raw token to ~/.zcouncil/token with 0600 perms so the next
// `npx -y zcouncil-cli` picks it up with no flag. We only save tokens
// passed via --token; env-var or already-saved tokens are left alone so
// we don't silently move a value from one source to another.
function saveTokenOnce(token) {
  try {
    const dir = dirname(TOKEN_PATH)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    const previous = existsSync(TOKEN_PATH) ? readFileSync(TOKEN_PATH, "utf8").trim() : ""
    if (previous === token) return
    writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 })
    chmodSync(TOKEN_PATH, 0o600)
    console.log(`Token saved — future runs will skip the prompt.`)
  } catch (err) {
    console.warn(`Couldn't save token to ${TOKEN_PATH}: ${err.message}`)
  }
}

function printHelp() {
  console.log(`zcouncil-cli ${CLI_VERSION}

  Local bridge to let zcouncil.com use your ChatGPT plan for the GPT
  council member. Reads your ChatGPT OAuth token from ${AUTH_PATH} —
  the file the official Codex CLI writes after \`codex login\`.

  Get a zcouncil token: ${PROD_SETTINGS_URL}

  Usage:
    npx zcouncil-cli                              (prompts for a token on first run,
                                                   reads ${TOKEN_PATH} after)
    npx zcouncil-cli --token <zcouncil-token>     (skip the prompt)
    npx zcouncil-cli logout                       (clear the saved token)
    ZCOUNCIL_TOKEN=<token> npx zcouncil-cli

  Options:
    --token <t>    zcouncil API token. Saved to ${TOKEN_PATH} on first
                   run so future runs don't need the flag. Overrides
                   any saved token.
    --bridge <u>   bridge WebSocket URL (default: ${DEFAULT_BRIDGE_URL})
    --version, -v
    --help, -h
`)
}

// ─── auth ───────────────────────────────────────────────────────────────────

function loadCodexAuth() {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(
      `${AUTH_PATH} not found. Install OpenAI's Codex CLI (\`npm i -g @openai/codex\`), run \`codex login\`, sign in with ChatGPT, then re-run zcouncil-cli.`,
    )
  }
  const raw = readFileSync(AUTH_PATH, "utf8")
  const file = JSON.parse(raw)
  if (file.auth_mode && file.auth_mode !== "chatgpt") {
    throw new Error(
      `Codex is in '${file.auth_mode}' mode, not 'chatgpt'. Run \`codex login\` and sign in with ChatGPT (not an API key).`,
    )
  }
  const t = file.tokens
  if (!t?.access_token || !t?.account_id) {
    throw new Error(
      `Codex auth file is missing tokens. Run \`codex login\` and complete the ChatGPT sign-in flow.`,
    )
  }
  return {
    accessToken: t.access_token,
    accountId: t.account_id,
    fileMtimeMs: statSync(AUTH_PATH).mtimeMs,
  }
}

// ─── codex SSE streaming ────────────────────────────────────────────────────

function buildCodexHeaders(auth, sessionId) {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    "chatgpt-account-id": auth.accountId,
    // originator + UA mirror the official Codex CLI so requests look
    // indistinguishable to ChatGPT's backend.
    originator: "codex_cli_rs",
    "User-Agent": "codex_cli_rs/0.1.0",
    "OpenAI-Beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
    session_id: sessionId,
    "x-client-request-id": sessionId,
  }
}

function buildCodexBody({ model, prompt, systemPrompt }, sessionId) {
  return JSON.stringify({
    model,
    store: false,
    stream: true,
    instructions: systemPrompt ?? "You are a helpful assistant.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    prompt_cache_key: sessionId,
  })
}

async function* streamCodex(auth, args) {
  const sessionId = crypto.randomUUID()
  const res = await fetch(CODEX_URL, {
    method: "POST",
    headers: buildCodexHeaders(auth, sessionId),
    body: buildCodexBody(args, sessionId),
  })
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200).replace(/\s+/g, " ")
    throw new Error(`codex HTTP ${res.status}: ${text}`)
  }
  if (!res.body) throw new Error("codex: empty response body")

  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  let buffer = ""
  let usage = { inputTokens: 0, outputTokens: 0 }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx = buffer.indexOf("\n\n")
      while (idx !== -1) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n")
        idx = buffer.indexOf("\n\n")
        if (!data || data === "[DONE]") continue
        let ev
        try {
          ev = JSON.parse(data)
        } catch {
          continue
        }
        if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
          yield { type: "delta", text: ev.delta }
        } else if (ev.type === "response.completed") {
          usage = {
            inputTokens: ev.response?.usage?.input_tokens ?? 0,
            outputTokens: ev.response?.usage?.output_tokens ?? 0,
          }
        } else if (ev.type === "response.failed" || ev.type === "error") {
          const msg = ev.response?.error?.message ?? ev.message ?? "codex stream failed"
          throw new Error(msg)
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      /* ignore */
    }
  }
  yield { type: "done", usage }
}

// ─── bridge protocol ────────────────────────────────────────────────────────

function shortCallId(id) {
  return typeof id === "string" ? id.slice(0, 5) : "unknown"
}

function callTag(msg) {
  if (typeof msg?.chatId === "string" && msg.chatId) return msg.chatId.slice(0, 5)
  return shortCallId(msg?.id)
}

function promptPreview(text, maxChars = 9) {
  if (typeof text !== "string") return "..."
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return "..."
  return compact.length > maxChars ? `${compact.slice(0, maxChars)}...` : compact
}

async function handleCall(ws, req) {
  const tag = callTag(req)
  if (!SUPPORTED_MODELS.includes(req.model)) {
    ws.send(JSON.stringify({ type: "error", id: req.id, message: `unsupported model: ${req.model}` }))
    console.log(`← ${req.model} [${tag}] error (unsupported model)`)
    return
  }
  let auth
  try {
    auth = loadCodexAuth()
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: req.id, message: err.message }))
    console.log(`← ${req.model} [${tag}] error (${err.message})`)
    return
  }
  let usage = null
  try {
    for await (const ev of streamCodex(auth, {
      model: req.model,
      prompt: req.prompt,
      systemPrompt: req.systemPrompt,
    })) {
      if (ev.type === "delta") {
        ws.send(JSON.stringify({ type: "delta", id: req.id, text: ev.text }))
      } else {
        usage = ev.usage
        ws.send(JSON.stringify({ type: "done", id: req.id, usage: ev.usage }))
      }
    }
    const usageSummary = usage ? `${usage.inputTokens} in / ${usage.outputTokens} out` : "done"
    console.log(`← ${req.model} [${tag}] ${usageSummary}`)
  } catch (err) {
    const message = err.message ?? String(err)
    ws.send(JSON.stringify({ type: "error", id: req.id, message }))
    console.log(`← ${req.model} [${tag}] error (${message})`)
  }
}

function connectOnce(opts) {
  return new Promise((resolve) => {
    const url = `${opts.bridgeUrl}?token=${encodeURIComponent(opts.token)}`
    const ws = new WebSocket(url)
    let opened = false

    ws.addEventListener("open", () => {
      opened = true
      console.log(`Connected to zcouncil.`)
      ws.send(
        JSON.stringify({
          type: "client_hello",
          protocolVersion: PROTOCOL_VERSION,
          cliVersion: CLI_VERSION,
          models: SUPPORTED_MODELS,
          pid: process.pid,
          hostname: hostname(),
        }),
      )
    })

    ws.addEventListener("message", (ev) => {
      const data = typeof ev.data === "string" ? ev.data : ev.data.toString("utf8")
      let msg
      try {
        msg = JSON.parse(data)
      } catch {
        return
      }
      switch (msg.type) {
        case "server_hello":
          console.log(`Listening for council requests…`)
          break
        case "call":
          console.log(`→ ${msg.model} [${callTag(msg)}] ${promptPreview(msg.prompt)}`)
          void handleCall(ws, msg)
          break
        case "cancel":
          console.log(`→ [${callTag(msg)}] canceled.`)
          break
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }))
          break
      }
    })

    ws.addEventListener("close", (ev) => {
      // Code 1000 = clean server-initiated close (user clicked Disconnect
      // in Settings, or another CLI instance took over). In either case
      // reconnecting would just fight the user, so we signal main() to
      // exit. Any other code (1006, etc.) is transport noise — retry.
      resolve({ opened, cleanClose: ev.code === 1000, reason: ev.reason })
    })

    ws.addEventListener("error", () => {
      // 'close' will follow with details
    })
  })
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv)

  // Interactive fallback when no token was passed and none is saved.
  // Runs before codex auth so users with neither set up see the
  // zcouncil prompt first (the friendlier of the two errors).
  if (!opts.token) {
    const pasted = await promptForToken(opts.bridgeUrl)
    if (!pasted) {
      console.error("")
      console.error("No token entered.")
      process.exit(2)
    }
    if (pasted === PLACEHOLDER_TOKEN || /^<.+>$/.test(pasted)) {
      console.error("")
      console.error(`"${pasted}" is the placeholder, not a real token.`)
      console.error(`Create one: ${settingsUrl(opts.bridgeUrl)}`)
      process.exit(2)
    }
    opts.token = pasted
    opts.tokenFromFlag = true
  }

  let auth
  try {
    auth = loadCodexAuth()
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
  console.log(`Signed in to ChatGPT as account ${auth.accountId.slice(0, 8)}.`)

  // Watch for codex rotating the token in the background — log when it
  // happens so users can correlate disconnects with refreshes.
  setInterval(() => {
    try {
      const next = loadCodexAuth()
      if (next.fileMtimeMs > auth.fileMtimeMs) {
        auth = next
        console.log(`ChatGPT token refreshed.`)
      }
    } catch (err) {
      console.warn(`Couldn't reload ChatGPT token: ${err.message}`)
    }
  }, 30_000)

  // Pre-flight: fail fast on a stale saved token so the user isn't
  // left staring at a silent retry loop. Transient failures
  // ("unreachable") fall through to the retry loop below. Saving a
  // freshly-passed `--token` happens AFTER preflight so a bad token
  // never lands in ~/.zcouncil/token.
  const preflight = await checkToken(opts)
  if (preflight === "invalid") exitOnInvalidToken(opts)
  if (opts.tokenFromFlag && preflight === "valid") saveTokenOnce(opts.token)

  let backoffMs = RECONNECT_BASE_MS
  for (;;) {
    const result = await connectOnce(opts)
    if (result.cleanClose) {
      // Server asked us to stop (Disconnect button or another CLI took
      // over). Bail cleanly — reconnecting would just fight the user.
      const suffix = result.reason ? ` (${result.reason})` : ""
      console.log(`Disconnected${suffix}. Bye.`)
      process.exit(0)
    }
    if (result.opened) {
      // Transport blip mid-session — log once, reset backoff.
      console.log(`Connection lost. Reconnecting…`)
      backoffMs = RECONNECT_BASE_MS
    } else {
      // Handshake never completed. Ask the server whether this is
      // auth (revoked mid-session) or transport (Convex/worker blip)
      // before deciding to retry.
      const check = await checkToken(opts)
      if (check === "invalid") exitOnInvalidToken(opts)
      console.log(`Couldn't reach zcouncil. Retrying in ${Math.round(backoffMs / 1000)}s…`)
    }
    await new Promise((r) => setTimeout(r, backoffMs))
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
  }
}

void main()
