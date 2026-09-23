import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandInvocation, type RuntimePermissionLevel } from "tau/host-extension";
import { GROK_HOME_VARIABLE } from "./protocol.js";

/**
 * What Tau asks of the Grok CLI outside a thread (its version, its login and
 * the models it names) and how a thread starts it. None of it writes to the
 * CLI's home.
 */

/** Set in Tau's environment, the CLI signs in with this key instead of its stored login. */
export const API_KEY_VARIABLE = "XAI_API_KEY";
/** The ACP `authenticate` methods: an API key from the environment, or the CLI's cached login. */
export const AUTH_API_KEY = "xai.api_key";
export const AUTH_CACHED_TOKEN = "cached_token";

export function parseGrokVersion(output: string): string | undefined {
  return /\bv?(\d+\.\d+\.\d+)\b/u.exec(output)?.[1];
}

/** An instance's home stands for `~/.grok`: config, login and sessions. */
export function grokEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = env[GROK_HOME_VARIABLE]?.trim();
  return home ? { ...env, GROK_HOME: home } : env;
}

export function usesApiKey(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env[API_KEY_VARIABLE]?.trim());
}

export function grokAuthMethod(env: NodeJS.ProcessEnv): string {
  return usesApiKey(env) ? AUTH_API_KEY : AUTH_CACHED_TOKEN;
}

/**
 * The CLI's ACP server. Its permission mode is fixed when it starts: full
 * access approves everything itself, anything else asks Tau, which refuses
 * for read-only and plan mode.
 */
export function grokAgentArgs(level: RuntimePermissionLevel, restricted: boolean): string[] {
  return level === "full" && !restricted ? ["agent", "--always-approve", "stdio"] : ["--permission-mode", "default", "agent", "stdio"];
}

export interface GrokModelsListing {
  /** True or false when the CLI said so; undefined when it printed neither. */
  signedIn?: boolean;
  /** What it is signed in with: `grok.com`. */
  account?: string;
  models: Array<{ id: string; isDefault: boolean }>;
}

/**
 * `grok models` exits 0 signed in or not, so its text is the only signal:
 *
 *     You are logged in with grok.com.
 *     Default model: grok-4.6
 *     Available models:
 *       * grok-4.6 (default)
 *       - grok-4.5
 */
export function parseGrokModels(output: string): GrokModelsListing {
  const login = /you are logged in(?: with ([^\s.]+(?:\.[^\s.]+)*))?/iu.exec(output);
  const signedIn = login ? true : /not authenticated|not logged in/iu.test(output) ? false : undefined;
  const seen = new Set<string>();
  const models: GrokModelsListing["models"] = [];
  for (const line of output.split(/\r?\n/u)) {
    const bullet = /^\s*[*-]\s+(\S+)(.*)$/u.exec(line);
    const id = bullet?.[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, isDefault: /\(default\)/iu.test(bullet[2] ?? "") });
  }
  return { ...(signedIn !== undefined ? { signedIn } : {}), ...(login?.[1] ? { account: login[1] } : {}), models };
}

async function run(path: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const invocation = commandInvocation(path, args, { env: env as Record<string, string> });
  const { stdout, stderr } = await promisify(execFile)(invocation.command, invocation.args, { env, timeout: timeoutMs, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments });
  return { stdout: String(stdout), stderr: String(stderr) };
}

export async function readGrokVersion(path: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await run(path, ["--version"], env, 10_000);
    return parseGrokVersion(`${stdout}\n${stderr}`);
  } catch {
    return undefined;
  }
}

/** Only a clean exit counts: a failed call prints help or an error, which is neither a model nor a verdict on the login. */
export async function readGrokModels(path: string, env: NodeJS.ProcessEnv): Promise<GrokModelsListing> {
  try {
    const { stdout, stderr } = await run(path, ["models"], env, 15_000);
    return parseGrokModels(`${stdout}\n${stderr}`);
  } catch {
    return { models: [] };
  }
}
