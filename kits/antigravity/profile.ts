import { chmod, lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { geminiConfigDirectory } from "./mcp.js";

/**
 * A private Google home for the ACP server, under Tau's own state folder.
 * The server keeps its token there itself; Tau never reads or copies a
 * credential. The browser the server would open is replaced by a helper
 * that prints the sign-in link, so the workbench can show it instead.
 */
export interface AntigravityProfile {
  geminiHome: string;
  acpDirectory: string;
  /** Where the server stores its OAuth token; Tau only knows the path. */
  tokenPath: string;
  settingsPath: string;
}

export type AntigravityAuthMethod = "oauth-personal" | "oauth-business" | "gemini-api-key" | "agent-platform";

export const AUTH_URL_PREFIX = "Open the following link to authenticate the ACP server: ";
export const BROWSER_MARKER = "__TAU_ANTIGRAVITY_AUTH_URL__";

/** The skill folders Antigravity reads, relative to a Gemini home. */
const SKILL_DIRECTORIES = ["config/skills", "antigravity-cli/skills"] as const;

/**
 * Points the private home's skill folders at the user's real ones. The agent
 * runs with a `GEMINI_HOME` of Tau's own, so without these links the skills
 * the user wrote would exist everywhere but here. Best effort: a missing
 * source or a filesystem without symlinks simply means no link.
 */
export async function linkUserSkills(profile: AntigravityProfile, geminiDir: string = geminiConfigDirectory()): Promise<string[]> {
  const linked: string[] = [];
  for (const relative of SKILL_DIRECTORIES) {
    const target = join(geminiDir, relative);
    const link = join(profile.geminiHome, relative);
    try {
      if ((await lstat(target)).isDirectory() !== true) continue;
    } catch {
      continue;
    }
    try {
      const existing = await lstat(link).catch(() => undefined);
      if (existing?.isSymbolicLink()) {
        if (await readlink(link) === target) { linked.push(relative); continue; }
        await rm(link);
      } else if (existing) {
        // Something real is in the way; never replace a directory the agent may own.
        continue;
      }
      await mkdir(join(link, ".."), { recursive: true, mode: 0o700 });
      await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
      linked.push(relative);
    } catch {
      // A link Tau cannot make is not worth failing a thread over.
    }
  }
  return linked;
}

export async function prepareProfile(stateDir: string, authMethod: AntigravityAuthMethod = "oauth-personal"): Promise<AntigravityProfile> {
  const geminiHome = join(stateDir, "profile");
  const acpDirectory = join(geminiHome, "antigravity-acp");
  await mkdir(acpDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(geminiHome, 0o700).catch(() => undefined);
    await chmod(acpDirectory, 0o700).catch(() => undefined);
  }
  const settingsPath = join(acpDirectory, "settings.json");
  // Names the method so a native logout clears only that method's credentials. Never holds a credential.
  await writeFile(settingsPath, `${JSON.stringify({ auth: { type: authMethod } })}\n`, { mode: 0o600 });
  return { geminiHome, acpDirectory, tokenPath: join(acpDirectory, "acp_token.json"), settingsPath };
}

/**
 * The helper's source: prints the link the agent asked a browser to open,
 * with a marker, and exits 0 even on a closed pipe so the agent never falls
 * back to a real browser. Python splits `$BROWSER` on the path separator
 * before it parses quotes, so the source carries no colon and no semicolon.
 */
const BROWSER_HELPER_SOURCE = `process.stderr.on("error",()=>process.exit(0)).write("${BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))`;

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\"'\"'")}'`;
}

/** `$BROWSER` for the agent: this Node (Electron as Node) running the helper, `%s` for the link. */
export function browserCommand(executable: string = process.execPath): string {
  if (/[\r\n\0%]/u.test(executable) || executable.includes(":") && process.platform !== "win32") {
    throw new Error("The Antigravity browser helper cannot be built from this executable path.");
  }
  return `${shellQuote(executable)} -e ${shellQuote(BROWSER_HELPER_SOURCE)} -- %s`;
}

const REMOVED_KEYS = new Set([
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION", "GOOGLE_CLOUD_QUOTA_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI", "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT", "AGY_ACP_CCPA_PROJECT", "AGY_ACP_ENABLE_OAUTH", "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE", "ANTIGRAVITY_HARNESS_PATH", "BROWSER", "PYTHONUNBUFFERED", "ELECTRON_RUN_AS_NODE",
]);

/** The complete environment of the server process: the login shell's, minus every Google credential and knob, plus Tau's. */
export function agentEnvironment(base: NodeJS.ProcessEnv, profile: AntigravityProfile, harnessPath: string, browser: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || REMOVED_KEYS.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  return {
    ...env,
    GEMINI_HOME: profile.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    BROWSER: browser,
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
    ANTIGRAVITY_HARNESS_PATH: harnessPath,
  };
}

export interface AuthorizationLink {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
}

/** A Google sign-in link the server asked to open, from its stdout line or the helper's marker line; anything else is not one. */
export function parseAuthorizationLink(line: string): AuthorizationLink | undefined {
  let candidate: string | undefined;
  if (line.startsWith(AUTH_URL_PREFIX)) candidate = line.slice(AUTH_URL_PREFIX.length).trim();
  else if (line.startsWith(BROWSER_MARKER)) {
    try {
      const decoded: unknown = JSON.parse(line.slice(BROWSER_MARKER.length).trim());
      if (typeof decoded === "string") candidate = decoded;
    } catch {
      return undefined;
    }
  }
  if (!candidate || candidate.length > 16_384 || /\s/u.test(candidate)) return undefined;
  let url: URL;
  try { url = new URL(candidate); } catch { return undefined; }
  if (url.origin !== "https://accounts.google.com" || url.pathname !== "/o/oauth2/v2/auth") return undefined;
  if (url.username || url.password || url.hash) return undefined;
  const single = (name: string) => { const values = url.searchParams.getAll(name); return values.length === 1 ? values[0] : undefined; };
  const state = single("state");
  const redirectUri = single("redirect_uri");
  if (single("response_type") !== "code" || !state || state.length > 512 || /\s/u.test(state) || !redirectUri) return undefined;
  const redirect = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/$/u.exec(redirectUri);
  if (!redirect || Number(redirect[1]) < 1024) return undefined;
  return { authorizationUrl: candidate, redirectUri, state };
}
