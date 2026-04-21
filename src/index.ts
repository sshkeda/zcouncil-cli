#!/usr/bin/env bun
// zcouncil-cli — local bridge that lets zcouncil.com use your ChatGPT plan.
//
// What this does, in one paragraph:
//
//   You sign in on zcouncil.com. You run this CLI on your laptop. The CLI
//   opens a WebSocket to api.zcouncil.com/bridge with your zcouncil session
//   token. When the council needs an answer from GPT, the worker sends a
//   request down the WebSocket. This CLI calls ChatGPT's backend from your
//   own IP using your own login (read from pi-ai's auth.json), streams the
//   reply back over the WebSocket, and the worker forwards it to your
//   browser. The token never touches our servers.
//
// Run:
//   bunx zcouncil-cli --token <your zcouncil session token>
//
// Or set ZCOUNCIL_TOKEN in env. Get the token from zcouncil.com → Settings →
// Bridge.
import { authChanged, loadCodexAuth } from "./auth.ts"
import { streamCodex, type CodexEvent } from "./codex.ts"
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type CallRequest,
  type ClientHello,
  type ClientMessage,
} from "./protocol.ts"

const CLI_VERSION = "0.1.0"
const SUPPORTED_MODELS = ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"]
const DEFAULT_BRIDGE_URL = "wss://api.zcouncil.com/bridge"
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

interface CliOptions {
  bridgeUrl: string
  token: string
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv.slice(2)
  let bridgeUrl = process.env.ZCOUNCIL_BRIDGE_URL ?? DEFAULT_BRIDGE_URL
  let token = process.env.ZCOUNCIL_TOKEN ?? ""
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--token" && args[i + 1]) {
      token = args[i + 1]!
      i++
    } else if (arg === "--bridge" && args[i + 1]) {
      bridgeUrl = args[i + 1]!
      i++
    } else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    } else if (arg === "--version" || arg === "-v") {
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

function printHelp(): void {
  console.log(`zcouncil-cli ${CLI_VERSION}

  Local bridge to let zcouncil.com use your ChatGPT plan for the GPT council
  member. Reads your codex token from pi-ai's auth.json (~/.pi/agent/auth.json).
  No token leaves your machine except in the Authorization header to
  chatgpt.com.

  Usage:
    zcouncil-cli --token <session-token>
    ZCOUNCIL_TOKEN=<token> zcouncil-cli

  Options:
    --token <t>    zcouncil session token (or env ZCOUNCIL_TOKEN)
    --bridge <u>   bridge WebSocket URL (default: ${DEFAULT_BRIDGE_URL})
    --version, -v
    --help, -h
`)
}

function send(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg))
}

async function handleCall(ws: WebSocket, req: CallRequest): Promise<void> {
  if (!SUPPORTED_MODELS.includes(req.model)) {
    send(ws, { type: "error", id: req.id, message: `unsupported model: ${req.model}` })
    return
  }
  let auth
  try {
    auth = loadCodexAuth()
  } catch (err) {
    send(ws, {
      type: "error",
      id: req.id,
      message: err instanceof Error ? err.message : "auth load failed",
    })
    return
  }
  try {
    const opts: Parameters<typeof streamCodex>[0] = {
      accessToken: auth.accessToken,
      accountId: auth.accountId,
      model: req.model,
      prompt: req.prompt,
    }
    if (req.systemPrompt !== undefined) opts.systemPrompt = req.systemPrompt
    const stream: AsyncGenerator<CodexEvent> = streamCodex(opts)
    for await (const ev of stream) {
      if (ev.type === "delta") {
        send(ws, { type: "delta", id: req.id, text: ev.text })
      } else {
        send(ws, { type: "done", id: req.id, usage: ev.usage })
      }
    }
  } catch (err) {
    send(ws, {
      type: "error",
      id: req.id,
      message: err instanceof Error ? err.message : "codex call failed",
    })
  }
}

function connectOnce(opts: CliOptions): Promise<void> {
  return new Promise((resolve) => {
    const url = `${opts.bridgeUrl}?token=${encodeURIComponent(opts.token)}`
    const ws = new WebSocket(url)
    let opened = false

    ws.addEventListener("open", () => {
      opened = true
      console.log(`[bridge] connected to ${opts.bridgeUrl}`)
      const hello: ClientHello = {
        type: "client_hello",
        protocolVersion: PROTOCOL_VERSION,
        cliVersion: CLI_VERSION,
        models: SUPPORTED_MODELS,
      }
      send(ws, hello)
    })

    ws.addEventListener("message", (ev) => {
      const data = typeof ev.data === "string" ? ev.data : ev.data.toString()
      const msg = parseServerMessage(data)
      if (!msg) {
        console.warn(`[bridge] dropped unparseable message: ${data.slice(0, 80)}`)
        return
      }
      switch (msg.type) {
        case "server_hello":
          console.log(`[bridge] handshake ok (server protocol ${msg.protocolVersion.toString()})`)
          break
        case "call":
          console.log(`[bridge] call ${msg.id} model=${msg.model} (${msg.prompt.length.toString()} chars)`)
          void handleCall(ws, msg)
          break
        case "cancel":
          // The current implementation runs each call serially without an
          // AbortController per id — cancellation is best-effort no-op for
          // now. Future: wire AbortSignal into streamCodex per id.
          console.log(`[bridge] cancel ${msg.id} (not yet implemented)`)
          break
        case "ping":
          send(ws, { type: "pong" })
          break
      }
    })

    ws.addEventListener("close", (ev) => {
      const reason = ev.reason || "no reason"
      console.warn(
        `[bridge] disconnected (code=${ev.code.toString()}, reason="${reason}", wasOpen=${opened.toString()})`,
      )
      resolve()
    })

    ws.addEventListener("error", () => {
      // close will follow
    })
  })
}

async function runForever(opts: CliOptions): Promise<void> {
  let auth
  try {
    auth = loadCodexAuth()
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
  console.log(
    `[auth] codex token loaded for account ${auth.accountId.slice(0, 8)}…${auth.expiresAt ? ` (expires ${new Date(auth.expiresAt).toISOString()})` : ""}`,
  )

  // Watch for pi rotating the token in the background — log when it happens
  // so users can correlate disconnects with refreshes.
  setInterval(() => {
    if (authChanged(auth!)) {
      try {
        auth = loadCodexAuth()
        console.log(`[auth] pi refreshed the token (mtime=${new Date(auth.fileMtimeMs).toISOString()})`)
      } catch (err) {
        console.warn(`[auth] reload failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }, 30_000)

  let backoffMs = RECONNECT_BASE_MS
  for (;;) {
    await connectOnce(opts)
    await new Promise((r) => setTimeout(r, backoffMs))
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS)
  }
}

const opts = parseArgs(process.argv)
void runForever(opts)
