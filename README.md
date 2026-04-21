# zcouncil-cli

A small bridge that lets [zcouncil.com](https://zcouncil.com) use **your**
ChatGPT plan for the GPT council member, instead of charging your account
per-token via OpenRouter.

## Why this exists

zcouncil runs three AI models in parallel (GPT, Gemini, Grok), then
synthesizes them. The Gemini and Grok calls happen on the server. The GPT
call uses OpenAI's `responses` endpoint, which is reachable two ways:

1. The paid OpenAI API — works from anywhere, costs per token.
2. The ChatGPT backend (`chatgpt.com/backend-api/codex/responses`) — free
   if you have a ChatGPT subscription, but it blocks server-side requests
   at the network layer (Cloudflare Worker IPs and TLS fingerprints get a
   403 from the WAF).

This CLI runs on **your laptop**, where requests look like a normal
browser. It opens a WebSocket to `api.zcouncil.com/bridge`, waits for the
server to ask for a GPT response, calls ChatGPT from your IP, and streams
the answer back. Your token never touches our servers.

## What goes over the network

```
Your laptop                         api.zcouncil.com
─────────────                       ──────────────────
zcouncil-cli  ◄── WebSocket ──►    bridge worker
     │                                    ▲
     │                                    │ (request) {model, prompt, systemPrompt}
     │ ◄────── (response) {delta, done, usage} ───────
     │
     ▼
chatgpt.com/backend-api/codex/responses
   Authorization: Bearer <your-codex-token>
   chatgpt-account-id: <your-account-id>
   originator: codex_cli_rs
   body: { model, instructions, input: [{ role: user, text: prompt }], ... }
```

- **What we (zcouncil) see:** the prompt (your chat message — we already
  have it), the streamed text reply, and a token-count for billing
  display. We do **not** see your ChatGPT OAuth token.
- **What ChatGPT sees:** a request indistinguishable from a normal
  Codex CLI call. Same headers, same originator. From your IP, with
  your account.

## Install

### Easy mode — paste a prompt into Codex CLI

Open [zcouncil.com → Settings → Bridge](https://zcouncil.com/chat#settings/bridge),
copy the install prompt (your session token is baked in), paste it into
[Codex CLI](https://developers.openai.com/codex/cli/). Codex checks
prerequisites (Bun, pi-ai), clones this repo, installs dependencies, and
runs the bridge in the foreground.

The same prompt is mirrored at [`PROMPT.md`](./PROMPT.md) if you want to
read or tweak it before running.

### Manual install

```bash
# Requires Bun 1.3+ — install: https://bun.sh
git clone https://github.com/sshkeda/zcouncil-cli
cd zcouncil-cli
bun install
bun src/index.ts --token <your token>
```

## Setup

1. Install OpenAI's official Codex CLI: `npm i -g @openai/codex`
2. Run `codex login`, choose **Sign in with ChatGPT**, complete the
   browser OAuth flow. This writes `~/.codex/auth.json` — that's where
   this CLI reads from. Codex CLI handles refresh in the background.
3. Sign in to [zcouncil.com](https://zcouncil.com). Open Settings → Bridge
   and copy your session token.
4. Run:

```bash
zcouncil-cli --token <paste your zcouncil session token>
```

You'll see:

```
[auth] codex token loaded for account 0f79602e…
[bridge] connected to wss://api.zcouncil.com/bridge
[bridge] handshake ok (server protocol 1)
```

Leave it running. zcouncil will use ChatGPT for every GPT call your account
makes, until you close the terminal.

## What it doesn't do

- **No keyboard input.** It's a daemon — you type your questions on
  zcouncil.com, not here.
- **No history.** This CLI doesn't store conversation history; the worker
  keeps that.
- **No telemetry.** No analytics, no error reporting, no auto-update.

## Auth and rotation

OpenAI's Codex CLI refreshes the ChatGPT OAuth token on its own
schedule (~24h cycles) — it owns the refresh-token grant. This CLI
re-reads `~/.codex/auth.json` on every request, so the next bridge
call after codex rotates picks up the new token automatically. No
restart needed.

## Falling back to paid

If you stop the CLI, zcouncil keeps working — the GPT council member
silently switches to OpenRouter (`openai/gpt-5.4`), which charges your
account per token. The status badge in Settings → Bridge shows whether a
local bridge is connected.

## Source layout

```
src/
├── index.ts      # entry — CLI args, WS reconnect loop, dispatch
├── auth.ts       # reads pi-ai's auth.json, extracts JWT account id
├── codex.ts      # POST + SSE parse for chatgpt.com/backend-api/codex
└── protocol.ts   # WebSocket message shapes (versioned)
```

Total: ~400 LOC, zero runtime deps.

## License

MIT — see [LICENSE](./LICENSE).
