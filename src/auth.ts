// Reads the codex OAuth access token from pi-ai's local auth store.
// pi-ai writes ~/.pi/agent/auth.json after a successful ChatGPT login. We
// read the same file so users only have to log in once (via pi).
//
// We never write to the file. We never send the token anywhere except
// chatgpt.com/backend-api when the worker requests a codex call.
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json")
const PROVIDER_KEY = "openai-codex"

interface OauthEntry {
  type: "oauth"
  access: string
  refresh?: string
  expires?: number
  accountId?: string
}
interface ApiKeyEntry {
  type: "api_key"
  key: string
}
type AuthEntry = OauthEntry | ApiKeyEntry

interface AuthFile {
  [provider: string]: AuthEntry
}

function isOauth(entry: AuthEntry | undefined): entry is OauthEntry {
  return !!entry && entry.type === "oauth" && typeof entry.access === "string"
}

function readAuthFile(): AuthFile {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(
      `${AUTH_PATH} not found. Install pi-ai (https://pi-ai.com), run \`pi\`, sign in to ChatGPT, then re-run zcouncil-cli.`,
    )
  }
  const raw = readFileSync(AUTH_PATH, "utf8")
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${AUTH_PATH} is not a JSON object`)
  }
  return parsed as AuthFile
}

interface CodexAuth {
  accessToken: string
  accountId: string
  expiresAt: number | null
  /** Mod time of auth.json — used to cheaply detect that pi has refreshed. */
  fileMtimeMs: number
}

const JWT_CLAIM = "https://api.openai.com/auth"

function extractAccountIdFromJwt(jwt: string): string {
  const parts = jwt.split(".")
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("codex token is not a valid JWT")
  }
  const payloadStr = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
  const decoded: unknown = JSON.parse(payloadStr)
  if (typeof decoded !== "object" || decoded === null || !(JWT_CLAIM in decoded)) {
    throw new Error("codex token has no OpenAI auth claim")
  }
  const claim = (decoded as Record<string, unknown>)[JWT_CLAIM]
  if (typeof claim !== "object" || claim === null) {
    throw new Error("codex token's OpenAI auth claim is malformed")
  }
  const accountId = (claim as Record<string, unknown>).chatgpt_account_id
  if (typeof accountId !== "string") {
    throw new Error("codex token has no chatgpt_account_id")
  }
  return accountId
}

export function loadCodexAuth(): CodexAuth {
  const file = readAuthFile()
  const entry = file[PROVIDER_KEY]
  if (!isOauth(entry)) {
    throw new Error(
      `No openai-codex OAuth entry in ${AUTH_PATH}. Run \`pi\` and choose "Sign in with ChatGPT".`,
    )
  }
  const accountId = extractAccountIdFromJwt(entry.access)
  const stat = statSync(AUTH_PATH)
  return {
    accessToken: entry.access,
    accountId,
    expiresAt: entry.expires ?? null,
    fileMtimeMs: stat.mtimeMs,
  }
}

/** True if auth.json was modified since the cached snapshot — pi has refreshed. */
export function authChanged(prev: CodexAuth): boolean {
  if (!existsSync(AUTH_PATH)) return false
  const stat = statSync(AUTH_PATH)
  return stat.mtimeMs > prev.fileMtimeMs
}
