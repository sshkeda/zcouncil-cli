#!/usr/bin/env node
// zcouncil-cli — optional local bridge for the GPT member on zcouncil.com.
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
import { createHash } from "node:crypto"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"

const CLI_VERSION = "0.3.5"
const PROTOCOL_VERSION = 1
const SUPPORTED_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]
const DEFAULT_BRIDGE_URL = "wss://api.zcouncil.com/bridge"
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
const AUTH_PATH = join(homedir(), ".codex", "auth.json")
const ZCOUNCIL_DIR = join(homedir(), ".zcouncil")
const TOKEN_DIR = join(ZCOUNCIL_DIR, "tokens")
const LEGACY_TOKEN_PATH = join(ZCOUNCIL_DIR, "token")
// Deep link — lands on the API tokens tab with the "New token" dialog
// already open. Falls through OAuth correctly because the action is a
// real query param (survives Google's callback), not a URL fragment.
const PROD_SETTINGS_URL = "https://zcouncil.com/chat?action=new-token"

// Derive the web origin from the bridge URL so `--bridge ws://localhost:8787/bridge`
// points the user at http://localhost:4321 (the local astro dev server)
// instead of prod. Production uses zcouncil.com. Preview workers follow
// zcouncil-worker-preview-pr-<N>.*.workers.dev and map to the matching
// Cloudflare Pages branch preview at https://pr-<N>.zcouncil.pages.dev.
function settingsUrl(bridgeUrl) {
  try {
    const u = new URL(bridgeUrl.replace(/^ws/, "http"))
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return "http://localhost:4321/chat?action=new-token"
    }
    if (u.hostname === "api.zcouncil.com") return PROD_SETTINGS_URL
    const preview = /^zcouncil-worker-preview-pr-(\d+)\./.exec(u.hostname)
    if (preview) return `https://pr-${preview[1]}.zcouncil.pages.dev/chat?action=new-token`
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

function normalizeBridgeUrl(raw) {
  try {
    const url = new URL(raw)
    url.hash = ""
    url.search = ""
    url.pathname = url.pathname.replace(/\/+$/, "") || "/"
    return url.toString()
  } catch {
    return raw.trim()
  }
}

function tokenPathForBridge(bridgeUrl) {
  const normalized = normalizeBridgeUrl(bridgeUrl)
  const hash = createHash("sha256").update(normalized).digest("hex").slice(0, 12)
  let label = "bridge"
  try {
    const url = new URL(normalized)
    label = `${url.hostname}${url.port ? `-${url.port}` : ""}${url.pathname.replace(/\W+/g, "-")}`
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
  } catch {
    label = normalized.replace(/\W+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "bridge"
  }
  return join(TOKEN_DIR, `${label}-${hash}`)
}

function logout(bridgeUrl) {
  const normalized = normalizeBridgeUrl(bridgeUrl)
  const tokenPath = tokenPathForBridge(bridgeUrl)
  const paths = [tokenPath]
  if (normalized === normalizeBridgeUrl(DEFAULT_BRIDGE_URL)) paths.push(LEGACY_TOKEN_PATH)
  const existing = paths.filter((path) => existsSync(path))
  if (existing.length === 0) {
    console.log(`Already logged out for ${normalized} (no saved token at ${tokenPath}).`)
    process.exit(0)
  }
  try {
    for (const path of existing) unlinkSync(path)
    console.log(`Logged out of ${normalized}. Cleared saved token${existing.length === 1 ? "" : "s"} at ${existing.join(", ")}.`)
    process.exit(0)
  } catch (err) {
    console.error(`Couldn't clear saved token for ${normalized}: ${err.message}`)
    process.exit(1)
  }
}

function parseArgs(argv) {
  const args = argv.slice(2)
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
  if (args.includes("logout")) logout(bridgeUrl)

  const tokenPath = tokenPathForBridge(bridgeUrl)
  // No explicit token? Fall back to the saved one for this bridge location, so
  // prod, localhost, and preview/debug bridges don't overwrite each other.
  let tokenFromFile = false
  let tokenFromLegacyFile = false
  if (!token && existsSync(tokenPath)) {
    try {
      const saved = readFileSync(tokenPath, "utf8").trim()
      if (saved) {
        token = saved
        tokenFromFile = true
      }
    } catch (err) {
      console.warn(`Couldn't read saved token at ${tokenPath}: ${err.message}`)
    }
  }
  // Backwards compatibility for users who already have ~/.zcouncil/token from
  // older CLI versions. Only use it for the default production bridge; local
  // and preview bridges should always get their own explicitly-created token.
  if (!token && normalizeBridgeUrl(bridgeUrl) === normalizeBridgeUrl(DEFAULT_BRIDGE_URL) && existsSync(LEGACY_TOKEN_PATH)) {
    try {
      const saved = readFileSync(LEGACY_TOKEN_PATH, "utf8").trim()
      if (saved) {
        token = saved
        tokenFromFile = true
        tokenFromLegacyFile = true
      }
    } catch (err) {
      console.warn(`Couldn't read legacy saved token at ${LEGACY_TOKEN_PATH}: ${err.message}`)
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
  return { bridgeUrl, token, tokenFromFlag, tokenFromFile, tokenFromLegacyFile, tokenPath }
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
  if (!process.stdin.isTTY) return ""
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question("2. Paste it here: ")
    return answer.trim()
  } finally {
    rl.close()
  }
}

// Server auth check: returns a status plus zcouncil account metadata when
// available. The metadata is only for local startup logging; the token remains
// the credential used for the WebSocket bridge.
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
    if (res.status === 401) return { status: "invalid", user: null }
    if (!res.ok) return { status: "unreachable", user: null }
    let json
    try {
      json = await res.json()
    } catch {
      return { status: "valid", user: null }
    }
    const user = json?.user
    if (typeof user?.id === "string" && typeof user?.email === "string") {
      return { status: "valid", user: { id: user.id, email: user.email } }
    }
    return { status: "valid", user: null }
  } catch {
    return { status: "unreachable", user: null }
  }
}

function exitOnInvalidToken(opts) {
  console.error("")
  console.error("That token isn't valid anymore (deleted, rotated, or never existed).")
  console.error(`Create a new one: ${settingsUrl(opts.bridgeUrl)}`)
  if (opts.tokenFromFile) {
    try {
      unlinkSync(opts.tokenPath)
      console.error(`Cleared the stale saved token.`)
    } catch {
      // ignore
    }
    if (opts.tokenFromLegacyFile) {
      try {
        unlinkSync(LEGACY_TOKEN_PATH)
      } catch {
        // ignore
      }
    }
  }
  process.exit(2)
}

async function replaceInvalidSavedToken(opts) {
  console.error("")
  console.error("Your saved zcouncil token is no longer valid.")
  console.error(`Create a new token: ${settingsUrl(opts.bridgeUrl)}`)
  if (!process.stdin.isTTY) {
    console.error("Run this in an interactive terminal to replace the saved token.")
    process.exit(2)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let pasted
  try {
    pasted = (await rl.question("Paste the new token: ")).trim()
  } finally {
    rl.close()
  }

  if (!pasted) {
    console.error("No token entered. Saved token left unchanged.")
    process.exit(2)
  }
  if (pasted === PLACEHOLDER_TOKEN || /^<.+>$/.test(pasted)) {
    console.error(`"${pasted}" is the placeholder, not a real token.`)
    console.error("Saved token left unchanged.")
    process.exit(2)
  }

  const nextOpts = { ...opts, token: pasted, tokenFromFile: false, tokenFromLegacyFile: false, tokenFromFlag: true }
  const check = await checkToken(nextOpts)
  if (check.status === "invalid") {
    console.error("That replacement token is also invalid. Saved token left unchanged.")
    process.exit(2)
  }
  if (check.status === "unreachable") {
    console.error("Couldn't verify the replacement token. Saved token left unchanged.")
    process.exit(2)
  }

  opts.token = pasted
  opts.tokenFromFile = false
  opts.tokenFromLegacyFile = false
  opts.tokenFromFlag = true
  return check
}

// Write the raw token to a bridge-scoped path with 0600 perms so the next
// run against the same bridge URL picks it up with no flag. We save explicit
// --token values, validated replacements for stale saved tokens, and migrate
// the old default-production ~/.zcouncil/token on first successful startup.
function saveTokenOnce(opts) {
  try {
    if (!existsSync(ZCOUNCIL_DIR)) {
      mkdirSync(ZCOUNCIL_DIR, { recursive: true, mode: 0o700 })
    }
    if (!existsSync(TOKEN_DIR)) {
      mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 })
    }
    const previous = existsSync(opts.tokenPath) ? readFileSync(opts.tokenPath, "utf8").trim() : ""
    if (previous === opts.token) return
    writeFileSync(opts.tokenPath, `${opts.token}\n`, { mode: 0o600 })
    chmodSync(opts.tokenPath, 0o600)
    if (opts.tokenFromLegacyFile) {
      try {
        unlinkSync(LEGACY_TOKEN_PATH)
      } catch {
        // ignore
      }
    }
    console.log(`Token saved for ${normalizeBridgeUrl(opts.bridgeUrl)} — future runs with this bridge will skip the prompt.`)
  } catch (err) {
    console.warn(`Couldn't save token to ${opts.tokenPath}: ${err.message}`)
  }
}

function printHelp() {
  console.log(`zcouncil-cli ${CLI_VERSION}

  Optional local bridge for the GPT member on zcouncil.com. You still
  chat in the web app; this process runs locally and uses the ChatGPT
  sign-in managed by OpenAI's Codex CLI at ${AUTH_PATH}.

  Get a zcouncil token: ${PROD_SETTINGS_URL}

  Usage:
    npx zcouncil-cli                              (prompts for a token on first run,
                                                   reads the saved token for ${DEFAULT_BRIDGE_URL} after)
    npx zcouncil-cli --token <zcouncil-token>     (skip the prompt)
    npx zcouncil-cli logout                       (clear the saved token for the selected bridge)
    ZCOUNCIL_TOKEN=<token> npx zcouncil-cli

  Options:
    --token <t>    zcouncil API token. Saved under ${TOKEN_DIR} for the
                   selected bridge URL, so prod/local/preview tokens stay
                   separate. Overrides any saved token.
    --bridge <u>   bridge WebSocket URL (default: ${DEFAULT_BRIDGE_URL})
    --version, -v
    --help, -h
`)
}

// ─── auth ───────────────────────────────────────────────────────────────────

function authEmailFrom(file, tokens) {
  const candidates = [
    tokens?.account_email,
    tokens?.email,
    file?.account_email,
    file?.email,
    file?.user?.email,
    file?.account?.email,
  ]
  return candidates.find((value) => typeof value === "string" && value.includes("@")) ?? null
}

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
    email: authEmailFrom(file, t),
    fileMtimeMs: statSync(AUTH_PATH).mtimeMs,
  }
}

function shortId(id) {
  return typeof id === "string" ? id.slice(0, 8) : "unknown"
}

function chatgptAccountLabel(auth) {
  const id = shortId(auth.accountId)
  return auth.email ? `${auth.email} (account ${id})` : `account ${id}`
}

function zcouncilAccountLabel(user) {
  return `${user.email} (user ${shortId(user.id)})`
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

function promptPreview(text, maxChars = 80) {
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
          console.log(`→ ${msg.model} [${callTag(msg)}] ${promptPreview(msg.promptPreview ?? msg.prompt)}`)
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
  console.log(`Signed in to ChatGPT as ${chatgptAccountLabel(auth)}.`)

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
  let preflight = await checkToken(opts)
  if (preflight.status === "invalid") {
    preflight = opts.tokenFromFile
      ? await replaceInvalidSavedToken(opts)
      : exitOnInvalidToken(opts)
  }
  if (preflight.status === "valid") {
    if (preflight.user) {
      console.log(`Signed in to zcouncil as ${zcouncilAccountLabel(preflight.user)}.`)
    }
    if (opts.tokenFromFlag || opts.tokenFromLegacyFile) saveTokenOnce(opts)
  }

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
      if (check.status === "invalid") exitOnInvalidToken(opts)
      console.log(`Couldn't reach zcouncil. Retrying in ${Math.round(backoffMs / 1000)}s…`)
    }
    await new Promise((r) => setTimeout(r, backoffMs))
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
  }
}

void main()
