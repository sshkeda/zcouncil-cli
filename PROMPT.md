# Codex install prompt

A short prompt to paste into [Codex CLI](https://developers.openai.com/codex/cli/).
Replace `<YOUR_ZCOUNCIL_TOKEN>` with the token from
[zcouncil.com → Settings → Bridge](https://zcouncil.com/chat#settings/bridge),
or use the in-app **Copy** button there to get it baked in.

It's deliberately short so a human can read it in 30 seconds before
pasting — no hidden steps, no curl-piped-into-bash, no token written
anywhere except the `--token` flag.

---

```text
Set up zcouncil-cli so zcouncil.com can use my ChatGPT plan for its GPT
council member. Persist until the bridge is live.

1. Verify Bun (`bun --version`) and the official Codex CLI (`codex --version` plus `~/.codex/auth.json` exists with `auth_mode: "chatgpt"`). If Bun is missing, install via `curl -fsSL https://bun.sh/install | bash`. If Codex is missing or not signed in, run `npm i -g @openai/codex && codex login` and pause for the browser flow.
2. `git clone https://github.com/sshkeda/zcouncil-cli ~/Code/zcouncil-cli` (or `git -C ~/Code/zcouncil-cli pull` if already cloned cleanly).
3. `cd ~/Code/zcouncil-cli && bun install`.
4. Run in the foreground: `bun src/index.ts --token <YOUR_ZCOUNCIL_TOKEN>`.
5. Confirm the log shows `[bridge] handshake ok`. Tell me the bridge is live and that closing the terminal disconnects it.

Constraints. Pass the token only via the `--token` flag — never write it to a file or to the shell environment. Do not edit anything in `~/Code/zcouncil-cli/src`; if install fails, report the error verbatim and stop.
```
