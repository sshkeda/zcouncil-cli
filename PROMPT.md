# Codex install prompt

A short prompt to paste into [Codex CLI](https://developers.openai.com/codex/cli/).
Replace `<YOUR_ZCOUNCIL_TOKEN>` with the token from
[zcouncil.com → Settings → Bridge](https://zcouncil.com/chat#settings/bridge),
or use the in-app **Copy** button there to get it baked in.

It's deliberately short so a human can read it in 30 seconds before
pasting — no curl-piped-into-bash, no token written anywhere except the
`--token` flag.

---

```text
Set up zcouncil-cli so zcouncil.com can use my ChatGPT plan for its GPT
council member. Persist until the bridge is live.

1. Verify Node 22+ (`node --version`) and the official Codex CLI (`codex --version` plus `~/.codex/auth.json` exists with `auth_mode: "chatgpt"`). If Codex is missing or not signed in, run `npm i -g @openai/codex && codex login` and pause for the browser flow.
2. Run in the foreground: `npx -y zcouncil-cli --token <YOUR_ZCOUNCIL_TOKEN>`.
3. Confirm the log shows `[bridge] handshake ok`. Tell me the bridge is live and that closing the terminal disconnects it.

Constraints. Pass the token only via the `--token` flag — never write it to a file or to the shell environment. If anything fails, report the error verbatim and stop.
```
