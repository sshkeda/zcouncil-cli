// Reads the ChatGPT OAuth token from the official OpenAI Codex CLI's
// local auth store. Codex writes ~/.codex/auth.json after the user runs
// `codex login` and signs in with ChatGPT. Codex also handles refresh in
// the background, so we just re-read the file when a request needs the
// latest access token.
//
// We never write to the file. We never send the token anywhere except
// chatgpt.com/backend-api when the worker requests a codex call.
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const AUTH_PATH = join(homedir(), ".codex", "auth.json")

interface CodexAuthFile {
  auth_mode?: "chatgpt" | "apikey" | string
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
}

function readAuthFile(): CodexAuthFile {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(
      `${AUTH_PATH} not found. Install OpenAI's Codex CLI (\`npm i -g @openai/codex\`), run \`codex login\`, sign in with ChatGPT, then re-run zcouncil-cli.`,
    )
  }
  const raw = readFileSync(AUTH_PATH, "utf8")
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${AUTH_PATH} is not a JSON object`)
  }
  return parsed as CodexAuthFile
}

export interface CodexAuth {
  accessToken: string
  accountId: string
  /** Mod time of auth.json — used to cheaply detect that codex has refreshed. */
  fileMtimeMs: number
}

export function loadCodexAuth(): CodexAuth {
  const file = readAuthFile()
  if (file.auth_mode && file.auth_mode !== "chatgpt") {
    throw new Error(
      `Codex is in '${file.auth_mode}' mode, not 'chatgpt'. Run \`codex login\` and sign in with ChatGPT (not an API key).`,
    )
  }
  const tokens = file.tokens
  if (!tokens?.access_token || !tokens.account_id) {
    throw new Error(
      `Codex auth file is missing tokens. Run \`codex login\` and complete the ChatGPT sign-in flow.`,
    )
  }
  const stat = statSync(AUTH_PATH)
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id,
    fileMtimeMs: stat.mtimeMs,
  }
}

/** True if auth.json was modified since the cached snapshot — codex has refreshed. */
export function authChanged(prev: CodexAuth): boolean {
  if (!existsSync(AUTH_PATH)) return false
  const stat = statSync(AUTH_PATH)
  return stat.mtimeMs > prev.fileMtimeMs
}
