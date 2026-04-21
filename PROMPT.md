# Install prompt

A single prompt you can paste into any coding agent (Codex CLI, Claude
Code, Cursor, etc.) to install and run zcouncil-cli on your machine.

The prompt below assumes the agent has shell access. Replace
`<YOUR_ZCOUNCIL_TOKEN>` with the token from
[zcouncil.com → Settings → Bridge](https://zcouncil.com/chat#settings/bridge).

---

```text
You are setting up zcouncil-cli on this machine. zcouncil.com runs three AI
models (GPT, Gemini, Grok) in parallel and synthesizes their answers. The
GPT call goes through the ChatGPT backend, which blocks server-side
requests at the network layer. This CLI bridges zcouncil.com to the
ChatGPT backend through this machine's connection so GPT calls run on the
user's existing ChatGPT plan instead of being billed to OpenRouter.

Persist until the CLI is running and the bridge handshake is confirmed in
the logs. Do not stop after writing files or printing instructions —
execute every step.

Prerequisites to verify before installing.
1. Bun 1.3.0 or newer is installed. Run `bun --version`. If missing,
   install with `curl -fsSL https://bun.sh/install | bash` and re-source
   the shell so `bun` is on PATH. If older than 1.3.0, run `bun upgrade`.
2. pi-ai is installed and signed in to ChatGPT. The CLI reads its OAuth
   token from `~/.pi/agent/auth.json`. Check the file exists and contains
   a JSON object with an `openai-codex` key whose `type` is `oauth`. If
   the file is missing or the key is absent, install pi-ai with
   `npm install -g @mariozechner/pi-coding-agent`, run `pi`, choose "Sign
   in with ChatGPT" from the auth menu, complete the browser OAuth flow,
   then re-check the file.

Install steps.
1. Clone the repo. `git clone https://github.com/sshkeda/zcouncil-cli ~/Code/zcouncil-cli`. If the directory already exists and is a clean clone, `git -C ~/Code/zcouncil-cli pull`. If it exists but is dirty, ask the user before touching it.
2. Install dependencies. `cd ~/Code/zcouncil-cli && bun install`.
3. Run the bridge in the foreground with the session token below.
   `bun src/index.ts --token <YOUR_ZCOUNCIL_TOKEN>`.
4. Wait up to 10 seconds and confirm the log contains the line
   `[bridge] handshake ok (server protocol 1)`. If you see a
   `[bridge] disconnected` line instead, copy the close code and reason
   verbatim and stop.

Constraints.
1. Do not write the token to any file inside or outside the repo. Pass it
   only via the `--token` flag or the `ZCOUNCIL_TOKEN` environment
   variable scoped to the running process.
2. Do not modify the user's shell rc files. Do not export the token to
   the global environment.
3. Do not run `pi` itself, install pi extensions, or edit `auth.json`.
   The CLI reads `auth.json`; it does not write to it.
4. Do not edit any file in `~/Code/zcouncil-cli/src`. If installation
   fails, report the failure — do not patch the source.

Success criteria. The CLI process is running in a terminal window. The
most recent log lines include the codex-token-loaded message and the
handshake-ok message from the bridge. Tell the user the bridge is
connected, that they can return to zcouncil.com, and that closing the
terminal window will disconnect the bridge.

If any prerequisite check or step fails, surface the exact error message
and stop. Do not silently fall back to a different installer or skip a
prerequisite. If the user must perform a browser OAuth, pause and tell
them what to do.
```
