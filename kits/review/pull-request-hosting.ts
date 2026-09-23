import { homedir } from "node:os";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { RequestService } from "./protocol.js";
import type { CliCall } from "./pull-request-cli.js";
import { defaultCliRunner, explainCliFailure, SERVICES, type CliRunner } from "./request-cli.js";

/** A signed-in login is asked for once an hour per host; a failed ask is not remembered. */
const VIEWER_TTL_MS = 60 * 60_000;

export interface HostingOptions {
  run?: CliRunner;
  now?(): number;
}

/** Where a remote URL points: `git@host:o/r.git`, `ssh://git@host:22/o/r`, `https://host/o/r.git`. */
export function parseRemote(url: string | undefined): { host: string; repo: string } | undefined {
  const value = url?.trim();
  if (!value) return undefined;
  let host: string | undefined;
  let path: string | undefined;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/u.exec(value);
  if (scp && !/^[a-z]+:\/\//iu.test(value)) {
    [, host, path] = scp;
  } else {
    try {
      const parsed = new URL(value);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  const repo = path?.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  // A host alias from ~/.ssh/config names no server the CLI knows.
  if (!host || !repo || !repo.includes("/") || !host.includes(".")) return undefined;
  return { host: host.toLowerCase(), repo };
}

/** The web URL of request `number` in a repository. */
export function requestUrlFor(service: RequestService, host: string, repo: string, number: number): string {
  return service === "gitlab" ? `https://${host}/${repo}/-/merge_requests/${number}` : `https://${host}/${repo}/pull/${number}`;
}

export interface Hosting {
  /** Runs one call of `gh` or `glab`; a failure becomes a sentence naming what is missing. */
  cli(service: RequestService, call: CliCall, action: string, options?: { maxBuffer?: number; cwd?: string }): Promise<string>;
  /** The signed-in login on a host, or undefined when the CLI will not say. */
  viewer(service: RequestService, host: string): Promise<string | undefined>;
}

export function createHosting(context: HostExtensionContext, options: HostingOptions = {}): Hosting {
  const { services } = context;
  const run = options.run ?? defaultCliRunner;
  const now = options.now ?? Date.now;
  const viewers = new Map<string, { at: number; login: Promise<string | undefined> }>();

  const cli: Hosting["cli"] = async (service, call, action, extra = {}) => {
    const facts = SERVICES[service];
    const command = services.findCommand(facts.tool);
    if (!command) throw new HostCommandError(`${facts.label} is not installed or not on your PATH. Install it from ${facts.install}, then run \`${facts.login}\`.`);
    services.noteSubprocess();
    try {
      // A call that names its repository needs no checkout to run in.
      return await run(command, call.args, extra.cwd ?? homedir(), { ...(call.input !== undefined ? { input: call.input } : {}), ...(extra.maxBuffer ? { maxBuffer: extra.maxBuffer } : {}) });
    } catch (error) {
      throw new HostCommandError(explainCliFailure(service, action, error));
    }
  };

  const viewer: Hosting["viewer"] = (service, host) => {
    const key = `${service}\0${host}`;
    const held = viewers.get(key);
    if (held && now() - held.at < VIEWER_TTL_MS) return held.login;
    const login = cli(service, { args: ["api", "--hostname", host, "user"] }, "Reading the signed-in account")
      .then((output) => {
        const raw = JSON.parse(output) as Record<string, unknown>;
        const value = service === "gitlab" ? raw.username : raw.login;
        return typeof value === "string" && value ? value : undefined;
      })
      .catch(() => undefined);
    viewers.set(key, { at: now(), login });
    void login.then((value) => { if (value === undefined && viewers.get(key)?.login === login) viewers.delete(key); });
    return login;
  };

  return { cli, viewer };
}
