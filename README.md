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
   originator: pi
   body: { model, instructions, input: [{ role: user, text: prompt }], ... }
```

- **What we (zcouncil) see:** the prompt (your chat message — we already
  have it), the streamed text reply, and a token-count for billing
  display. We do **not** see your codex OAuth token.
- **What ChatGPT sees:** a request that looks like pi-ai. Identical
  headers. From your IP, with your account.

## Install

### Easy mode — let your coding agent do it

Paste [`PROMPT.md`](./PROMPT.md) into Codex CLI, Claude Code, Cursor, or
any agent with shell access. Replace `<YOUR_ZCOUNCIL_TOKEN>` with the
token from [zcouncil.com → Settings → Bridge](https://zcouncil.com/chat#settings/bridge).
The agent will check prerequisites (Bun, pi-ai), clone the repo, install
deps, and run the bridge in the foreground. The Bridge tab in Settings
also has a one-click "Copy install prompt" button that bakes the token in.

### Manual install

```bash
# Requires Bun 1.3+ — install: https://bun.sh
git clone https://github.com/sshkeda/zcouncil-cli
cd zcouncil-cli
bun install
bun src/index.ts --token <your token>
```

## Setup

1. Install [pi-ai](https://pi-ai.com): `npm i -g @mariozechner/pi-coding-agent`
2. Run `pi`, choose **Sign in with ChatGPT** in the auth menu. This
   writes `~/.pi/agent/auth.json` — that's where this CLI reads from.
3. Sign in to [zcouncil.com](https://zcouncil.com). Open Settings → Bridge
   and copy your session token.
4. Run:

```bash
zcouncil-cli --token <paste your zcouncil session token>
```

You'll see:

```
[auth] codex token loaded for account 0f79602e… (expires 2026-04-22T11:31:22.000Z)
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

pi-ai refreshes the codex OAuth token on its own schedule (~24h cycles).
This CLI re-reads `auth.json` whenever a request arrives, so the next
codex call after pi rotates will use the new token automatically. No
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
