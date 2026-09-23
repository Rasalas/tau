import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandInvocation, readPersistedJson, versionCompatibility, writePersistedJson, type RuntimeCompatibility, type VersionPolicy } from "tau/host-extension";
import { CURSOR_HOME_VARIABLE, MIN_CURSOR_VERSION } from "./protocol.js";

/**
 * What Tau asks of the Cursor CLI outside a thread: its version, who it is
 * signed in as, and the newest release Cursor's install script names. None of
 * it writes to the CLI's home beyond what the CLI itself does on start.
 */

/** Cursor's versions are dates with a build hash: `2026.09.18-9a7762b`. */
const VERSION = /\b(\d{4})\.(\d{2})\.(\d{2})(?:-[0-9a-f]+)?\b/u;
const INSTALL_SCRIPT = "https://cursor.com/install";
const RELEASE = /downloads\.cursor\.com\/lab\/(\d{4}\.\d{2}\.\d{2}-[0-9a-f]+)\//u;
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

export function parseCursorVersion(output: string): string | undefined {
  return VERSION.exec(output)?.[0];
}

/** The version as `x.y.z` for Tau's range checks: `2026.9.18`. */
export function comparableVersion(version: string | undefined): string | undefined {
  const match = version ? VERSION.exec(version) : undefined;
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : undefined;
}

const minimum = comparableVersion(MIN_CURSOR_VERSION)!;

/** Before this release `agent acp` is missing or lacks the model picker Tau asks for; an old CLI would read `acp` as a prompt. */
export const CURSOR_VERSION_POLICY: VersionPolicy = {
  ranges: [{ range: `<${minimum}`, status: "broken", message: `Tau speaks to the Cursor CLI over ACP, which needs version ${MIN_CURSOR_VERSION} or newer.` }],
};

export function cursorCompatibility(policy: VersionPolicy | undefined, version: string | undefined): RuntimeCompatibility | undefined {
  return versionCompatibility(policy, comparableVersion(version));
}

/**
 * An instance's home stands for `~/.cursor`: config and chats live there, and
 * so does the login, in a file instead of the keychain, so two homes are two
 * accounts.
 */
export function cursorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = env[CURSOR_HOME_VARIABLE]?.trim();
  if (!home) return env;
  return { ...env, CURSOR_CONFIG_DIR: home, CURSOR_DATA_DIR: home, AGENT_CLI_CREDENTIAL_STORE: "file" };
}

async function run(path: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const invocation = commandInvocation(path, args, { env: env as Record<string, string> });
  const { stdout, stderr } = await promisify(execFile)(invocation.command, invocation.args, { env, timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  return { stdout: String(stdout), stderr: String(stderr) };
}

export async function readCursorVersion(path: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    return parseCursorVersion((await run(path, ["--version"], env, 10_000)).stdout);
  } catch {
    return undefined;
  }
}

export interface CursorAbout {
  signedIn?: boolean;
  account?: string;
  plan?: string;
}

function planLabel(tier: string): string {
  return tier.split(/[\s_-]+/u).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(" ");
}

/** `agent about --format json`: `userEmail` null means signed out; a missing field says nothing. */
export function parseCursorAbout(stdout: string): CursorAbout {
  let payload: { userEmail?: unknown; subscriptionTier?: unknown };
  try {
    payload = JSON.parse(stdout.trim()) as typeof payload;
  } catch {
    return {};
  }
  if (!payload || typeof payload !== "object") return {};
  const tier = typeof payload.subscriptionTier === "string" && payload.subscriptionTier.trim() ? planLabel(payload.subscriptionTier.trim()) : undefined;
  if (!("userEmail" in payload)) return tier ? { plan: tier } : {};
  const email = typeof payload.userEmail === "string" ? payload.userEmail.trim() : "";
  if (!email || /not logged in|login required|authentication required/iu.test(email)) return { signedIn: false };
  return { signedIn: true, account: email, ...(tier ? { plan: tier } : {}) };
}

export async function readCursorAbout(path: string, env: NodeJS.ProcessEnv): Promise<CursorAbout> {
  try {
    return parseCursorAbout((await run(path, ["about", "--format", "json"], env, 15_000)).stdout);
  } catch {
    return {};
  }
}

/** The release `cursor.com/install` downloads, asked at most once a day; a failure answers the cached one or nothing. */
export async function cursorLatestVersion(options: { cacheFile: string; fetch?: typeof globalThis.fetch; now?(): number }): Promise<string | undefined> {
  const now = options.now ?? Date.now;
  const decode = (value: unknown) => {
    const { version, checkedAt } = (value ?? {}) as { version?: unknown; checkedAt?: unknown };
    return typeof version === "string" && typeof checkedAt === "number" ? { version, checkedAt } : undefined;
  };
  const cached = (await readPersistedJson(options.cacheFile, { expectedVersion: CACHE_VERSION, decode, logger: { warn: () => undefined } }).catch(() => undefined))?.data;
  if (cached && now() - cached.checkedAt < DAY_MS) return cached.version;
  try {
    const response = await (options.fetch ?? globalThis.fetch)(INSTALL_SCRIPT, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return cached?.version;
    const version = RELEASE.exec(await response.text())?.[1];
    if (!version) return cached?.version;
    await writePersistedJson(options.cacheFile, CACHE_VERSION, { version, checkedAt: now() }, { logger: { warn: () => undefined } }).catch(() => undefined);
    return version;
  } catch {
    return cached?.version;
  }
}

/** The CLI updates itself; a path with spaces is quoted for the shell. */
export function cursorUpdateCommand(path: string): string {
  return `${/\s/u.test(path) ? JSON.stringify(path) : path} update`;
}
