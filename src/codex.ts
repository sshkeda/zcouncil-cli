// Calls the ChatGPT backend (the same endpoint pi-ai uses for the
// "Sign in with ChatGPT" flow) and yields streaming text deltas.
//
// What goes over the network:
//   - To chatgpt.com/backend-api/codex/responses: the OAuth token (Bearer),
//     the user's ChatGPT account id (extracted from the JWT), the model id,
//     the prompt, and an optional system prompt. No chat history. No metadata
//     about other council members.
//   - The token is yours — pi-ai stored it locally, this CLI reads it
//     locally, and it never leaves your machine except in this Authorization
//     header.
//
// What does NOT happen:
//   - We never log the token, prompt, or response anywhere.
//   - We never send anything to zcouncil.com other than the streaming text
//     reply (and a token-count usage record). The worker can already see
//     the prompt — it's the user's chat message.
const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"

export interface CodexCallArgs {
  accessToken: string
  accountId: string
  model: string
  prompt: string
  systemPrompt?: string
  signal?: AbortSignal
}

export interface CodexUsage {
  inputTokens: number
  outputTokens: number
}

export type CodexEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage: CodexUsage }

interface CompletedResponse {
  usage?: { input_tokens?: number; output_tokens?: number }
}

interface SSEEvent {
  type?: unknown
  delta?: unknown
  response?: unknown
  message?: unknown
}

function buildHeaders(args: CodexCallArgs, sessionId: string): Headers {
  const h = new Headers()
  h.set("Authorization", `Bearer ${args.accessToken}`)
  h.set("chatgpt-account-id", args.accountId)
  // Match pi-ai's originator + UA so ChatGPT's WAF treats us identically.
  // Both fields read "pi" — the backend cross-references them.
  h.set("originator", "pi")
  h.set("User-Agent", "pi (browser)")
  h.set("OpenAI-Beta", "responses=experimental")
  h.set("accept", "text/event-stream")
  h.set("content-type", "application/json")
  h.set("session_id", sessionId)
  h.set("x-client-request-id", sessionId)
  return h
}

function buildBody(args: CodexCallArgs, sessionId: string): string {
  return JSON.stringify({
    model: args.model,
    store: false,
    stream: true,
    instructions: args.systemPrompt ?? "You are a helpful assistant.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: args.prompt }],
      },
    ],
    text: { verbosity: "medium" },
    include: ["reasoning.encrypted_content"],
    tool_choice: "auto",
    parallel_tool_calls: true,
    prompt_cache_key: sessionId,
  })
}

async function* readSSEFrames(body: Response["body"]): AsyncGenerator<string> {
  if (!body) return
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ""
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
        if (data && data !== "[DONE]") yield data
        idx = buffer.indexOf("\n\n")
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

function parseEvent(json: string): SSEEvent | null {
  try {
    const v: unknown = JSON.parse(json)
    if (typeof v === "object" && v !== null) return v as SSEEvent
  } catch {
    // skip malformed frames
  }
  return null
}

function extractUsage(response: unknown): CodexUsage {
  if (typeof response !== "object" || response === null) {
    return { inputTokens: 0, outputTokens: 0 }
  }
  const u = (response as CompletedResponse).usage
  return {
    inputTokens: typeof u?.input_tokens === "number" ? u.input_tokens : 0,
    outputTokens: typeof u?.output_tokens === "number" ? u.output_tokens : 0,
  }
}

export async function* streamCodex(args: CodexCallArgs): AsyncGenerator<CodexEvent> {
  const sessionId = crypto.randomUUID()
  const init: RequestInit = {
    method: "POST",
    headers: buildHeaders(args, sessionId),
    body: buildBody(args, sessionId),
  }
  if (args.signal) init.signal = args.signal
  const res = await fetch(CODEX_URL, init)
  if (!res.ok) {
    const txt = (await res.text()).slice(0, 200).replace(/\s+/g, " ")
    throw new Error(`codex HTTP ${res.status.toString()}: ${txt}`)
  }
  if (!res.body) throw new Error("codex: empty response body")

  let usage: CodexUsage = { inputTokens: 0, outputTokens: 0 }
  for await (const frame of readSSEFrames(res.body)) {
    const ev = parseEvent(frame)
    if (!ev) continue
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") {
      yield { type: "delta", text: ev.delta }
    } else if (ev.type === "response.completed") {
      usage = extractUsage(ev.response)
    } else if (ev.type === "response.failed" || ev.type === "error") {
      const msg = typeof ev.message === "string" ? ev.message : "codex stream failed"
      throw new Error(msg)
    }
  }
  yield { type: "done", usage }
}
