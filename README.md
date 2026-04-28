# zcouncil-cli

`zcouncil-cli` is the optional local bridge for [zcouncil.com](https://zcouncil.com).
It lets council members run through local subscriptions on your computer,
including ChatGPT via Codex and Claude Code.

You still chat on zcouncil.com. The CLI just sits in a terminal, waits for model
work, sends that work from your machine, and streams the answer back to your
council.

## Why Use It?

zcouncil is built around comparison: one chat, multiple AI models, clear
disagreements. GPT and Claude members can use this local bridge while the rest
of the council continues through zcouncil's hosted service.

That means:

- your ChatGPT access token stays on your computer
- zcouncil still receives the prompt and GPT response needed to show your chat
- you can close the terminal whenever you want to disconnect the bridge
- if the bridge is not running, zcouncil can fall back to hosted cloud routes

The CLI is not required to use zcouncil. It is there if you want local
subscriptions to power supported council members.

## Install

You need Node 22+ and at least one supported local provider:

```bash
# ChatGPT route
npm i -g @openai/codex
codex login

# Claude route
claude setup-token

npx -y zcouncil-cli
```

On first run, `zcouncil-cli` prints a link to create a zcouncil API token:

```text
No zcouncil token found.

1. Create one: https://zcouncil.com/chat?action=new-token
2. Paste it here:
```

Create a token, paste it into the terminal, and leave the process running.
After the token is validated, it is saved under `~/.zcouncil/tokens/` with
local file permissions and scoped to the bridge URL you used. Production,
localhost, and preview/debug bridges can each keep their own token, so future
runs against the same bridge can start with:

```bash
npx -y zcouncil-cli
```

Local development keeps a separate token automatically:

```bash
node bridge.mjs --bridge ws://localhost:8787/bridge
```

To disconnect, close the terminal. To remove the saved zcouncil token for the
selected bridge:

```bash
npx -y zcouncil-cli logout
npx -y zcouncil-cli --bridge ws://localhost:8787/bridge logout
```

## What You Should See

When everything is connected:

```text
Signed in to ChatGPT as you@gmail.com (account 0f79602e).
Claude Code detected.
Bridge models: gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, claude-code/opus-4.7.
Signed in to zcouncil as you@example.com (user j57abcde).
Connected to zcouncil.
Listening for council requests…
```

Leave that terminal open while you use zcouncil. If the terminal closes, the
local bridge disconnects.

## What Moves Where

```text
Your computer                         zcouncil bridge
-------------                         ---------------
zcouncil-cli  <---- WebSocket ---->   api.zcouncil.com
     |
     | sends requests using local provider CLIs
     v
ChatGPT / Claude Code
```

In plain terms:

- zcouncil sees the chat content needed to provide the service: your prompt, the
  model response, and basic usage information
- zcouncil does not receive your ChatGPT or Claude Code credentials
- the CLI reads ChatGPT auth from `~/.codex/auth.json`, the file managed by the
  official Codex CLI; Claude Code auth stays inside Claude Code
- the zcouncil API token is stored locally under `~/.zcouncil/tokens/`, scoped by bridge URL

For the full data and legal terms, read the zcouncil
[Privacy Policy](https://zcouncil.com/privacy) and
[Terms of Service](https://zcouncil.com/terms).

## What It Does Not Do

- It does not replace zcouncil.com. You still type prompts in the web app.
- It does not store your chat history locally.
- It does not send analytics, telemetry, or crash reports.
- It does not auto-update itself.
- It does not recover old zcouncil API tokens. If you lose one, create a new one
  from zcouncil settings.

## Your Responsibility

Only use the bridge with accounts and credentials you are allowed to use. You
are responsible for your device, your zcouncil API token, your ChatGPT account,
and complying with the terms and usage policies that apply to the services you
connect.

Do not submit sensitive regulated data, credentials, payment card information,
or anything else prohibited by the zcouncil Terms of Service.

## Inspect Before Running

The package is one executable file with no runtime dependencies.

```bash
curl -fsSL https://unpkg.com/zcouncil-cli/bridge.mjs | less
```

To run that inspected copy directly:

```bash
curl -fsSL https://unpkg.com/zcouncil-cli/bridge.mjs -o bridge.mjs
node bridge.mjs
```

## Requirements

- Node 22 or newer
- OpenAI's Codex CLI signed in with ChatGPT
- a zcouncil account

## Source Layout

```text
bridge.mjs   # CLI, auth loading, token prompt, WebSocket bridge
package.json # npm package metadata
```

No build step. No bundled dependencies.

## License

MIT. See [LICENSE](./LICENSE).
