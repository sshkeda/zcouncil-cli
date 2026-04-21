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

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CLI_VERSION = "0.2.0"
const PROTOCOL_VERSION = 1
const SUPPORTED_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]
const DEFAULT_BRIDGE_URL = "wss://api.zcouncil.com/bridge"
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
const AUTH_PATH = join(homedir(), ".codex", "auth.json")
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

function parseArgs(argv) {
  const args = argv.slice(2)
  let bridgeUrl = process.env.ZCOUNCIL_BRIDGE_URL ?? DEFAULT_BRIDGE_URL
  let token = process.env.ZCOUNCIL_TOKEN ?? ""
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--token" && args[i + 1]) {
      token = args[++i]
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
  if (!token) {
    console.error("error: missing --token (or ZCOUNCIL_TOKEN env)")
    console.error("get one from https://zcouncil.com/chat#settings/billing")
    process.exit(2)
  }
  return { bridgeUrl, token }
}

function printHelp() {
  console.log(`zcouncil-cli ${CLI_VERSION}

  Local bridge to let zcouncil.com use your ChatGPT plan for the GPT
  council member. Reads your ChatGPT OAuth token from ${AUTH_PATH} —
  the file the official Codex CLI writes after \`codex login\`.

  Usage:
    npx zcouncil-cli --token <session-token>
    ZCOUNCIL_TOKEN=<token> npx zcouncil-cli

  Options:
    --token <t>    zcouncil session token (or env ZCOUNCIL_TOKEN)
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

async function handleCall(ws, req) {
  if (!SUPPORTED_MODELS.includes(req.model)) {
    ws.send(JSON.stringify({ type: "error", id: req.id, message: `unsupported model: ${req.model}` }))
    return
  }
  let auth
  try {
    auth = loadCodexAuth()
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: req.id, message: err.message }))
    return
  }
  try {
    for await (const ev of streamCodex(auth, {
      model: req.model,
      prompt: req.prompt,
      systemPrompt: req.systemPrompt,
    })) {
      if (ev.type === "delta") {
        ws.send(JSON.stringify({ type: "delta", id: req.id, text: ev.text }))
      } else {
        ws.send(JSON.stringify({ type: "done", id: req.id, usage: ev.usage }))
      }
    }
  } catch (err) {
    ws.send(JSON.stringify({ type: "error", id: req.id, message: err.message ?? String(err) }))
  }
}

function connectOnce(opts) {
  return new Promise((resolve) => {
    const url = `${opts.bridgeUrl}?token=${encodeURIComponent(opts.token)}`
    const ws = new WebSocket(url)
    let opened = false

    ws.addEventListener("open", () => {
      opened = true
      console.log(`[bridge] connected to ${opts.bridgeUrl}`)
      ws.send(
        JSON.stringify({
          type: "client_hello",
          protocolVersion: PROTOCOL_VERSION,
          cliVersion: CLI_VERSION,
          models: SUPPORTED_MODELS,
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
          console.log(`[bridge] handshake ok (server protocol ${msg.protocolVersion})`)
          break
        case "call":
          console.log(`[bridge] call ${msg.id} model=${msg.model} (${msg.prompt.length} chars)`)
          void handleCall(ws, msg)
          break
        case "cancel":
          console.log(`[bridge] cancel ${msg.id} (not yet implemented)`)
          break
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }))
          break
      }
    })

    ws.addEventListener("close", (ev) => {
      console.warn(
        `[bridge] disconnected (code=${ev.code}, reason="${ev.reason || "no reason"}", wasOpen=${opened})`,
      )
      resolve()
    })

    ws.addEventListener("error", () => {
      // 'close' will follow with details
    })
  })
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv)
  let auth
  try {
    auth = loadCodexAuth()
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
  console.log(`[auth] codex token loaded for account ${auth.accountId.slice(0, 8)}…`)

  // Watch for codex rotating the token in the background — log when it
  // happens so users can correlate disconnects with refreshes.
  setInterval(() => {
    try {
      const next = loadCodexAuth()
      if (next.fileMtimeMs > auth.fileMtimeMs) {
        auth = next
        console.log(`[auth] codex refreshed the token (mtime=${new Date(next.fileMtimeMs).toISOString()})`)
      }
    } catch (err) {
      console.warn(`[auth] reload failed: ${err.message}`)
    }
  }, 30_000)

  let backoffMs = RECONNECT_BASE_MS
  for (;;) {
    await connectOnce(opts)
    await new Promise((r) => setTimeout(r, backoffMs))
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
  }
}

void main()
