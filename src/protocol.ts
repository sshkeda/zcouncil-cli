// Wire protocol between zcouncil-cli and the zcouncil worker bridge.
// Versioned via `protocolVersion` in the hello message — bumping requires
// the worker to handle both old and new clients during a rollout.
//
// All messages are JSON, one per WebSocket frame.

export const PROTOCOL_VERSION = 1

// ─────────────────────────────────────────────────────────────────────────────
// Server (worker) → Client (CLI)
// ─────────────────────────────────────────────────────────────────────────────

export interface ServerHello {
  type: "server_hello"
  protocolVersion: number
}

export interface CallRequest {
  type: "call"
  /** Opaque request id; client echoes it on every response chunk. */
  id: string
  model: string
  prompt: string
  systemPrompt?: string
}

/** Cancellation — client should abort the in-flight call. */
export interface CallCancel {
  type: "cancel"
  id: string
}

export interface ServerPing {
  type: "ping"
}

export type ServerMessage = ServerHello | CallRequest | CallCancel | ServerPing

// ─────────────────────────────────────────────────────────────────────────────
// Client (CLI) → Server (worker)
// ─────────────────────────────────────────────────────────────────────────────

export interface ClientHello {
  type: "client_hello"
  protocolVersion: number
  cliVersion: string
  /** Models the client believes it can serve, e.g. ["gpt-5.4", "gpt-5.4-mini"]. */
  models: string[]
}

export interface CallDelta {
  type: "delta"
  id: string
  text: string
}

export interface CallDone {
  type: "done"
  id: string
  usage: { inputTokens: number; outputTokens: number }
}

export interface CallError {
  type: "error"
  id: string
  message: string
}

export interface ClientPong {
  type: "pong"
}

export type ClientMessage = ClientHello | CallDelta | CallDone | CallError | ClientPong

// ─────────────────────────────────────────────────────────────────────────────
// Type guards — server messages may arrive malformed; the client must
// validate before acting.
// ─────────────────────────────────────────────────────────────────────────────

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== "object" || v === null || !("type" in v)) return null
    const t = (v as { type: unknown }).type
    if (t === "server_hello" || t === "call" || t === "cancel" || t === "ping") {
      return v as ServerMessage
    }
  } catch {
    // ignore
  }
  return null
}
