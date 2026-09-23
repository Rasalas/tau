import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { providerInfo, REQUEST_SERVICES, WORKSPACE_HOST_EXTENSION_ID, type PullRequestRef, type RequestService } from "./protocol.js";
import type { GitCredential, HttpAnswer, HttpFetch, ProviderTools, SourceControlProvider } from "./provider.js";
import { createGitHubProvider } from "./provider-github.js";
import { createAzureProvider } from "./provider-azure.js";
import { createBitbucketProvider } from "./provider-bitbucket.js";
import { createForgejoProvider } from "./provider-forgejo.js";
import { createGitLabProvider } from "./provider-gitlab.js";
import { isRateLimited, RateLimitGate, retryAtFrom } from "./provider-rate-limit.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { defaultCliRunner, explainCliFailure, remoteHost, serviceFor, SERVICES, type CliRunner } from "./request-cli.js";

/** A read is reused this long, for a tab reopened or a second client; `fresh` skips it. */
const READ_TTL_MS = 60_000;
/** A signed-in login is asked for once an hour per host; a failed ask is not remembered. */
const VIEWER_TTL_MS = 60 * 60_000;
/** A credential is held in memory this long, never written anywhere. */
const CREDENTIAL_TTL_MS = 60_000;
const HTTP_TIMEOUT_MS = 25_000;
const HOSTS_FILE = "source-hosts.json";

export interface SourceControlOptions {
  run?: CliRunner;
  now?(): number;
  /** HTTP for the providers without a CLI; the host's `fetch` unless a test hands one in. */
  fetch?: HttpFetch;
  /** Read for provider overrides such as `TAU_BITBUCKET_API_URL`; the process's own by default. */
  env?: Record<string, string | undefined>;
}

/** Review Kit's providers, the one that serves a remote or a URL, and the user's choice for self-hosted servers. */
export interface SourceControl {
  get(kind: RequestService): SourceControlProvider;
  all(): readonly SourceControlProvider[];
  /** The provider and request a web URL names; undefined for anything else. */
  forUrl(url: string): { provider: SourceControlProvider; ref: PullRequestRef } | undefined;
  /** The provider a remote belongs to (see `serviceFor`). */
  detect(remoteUrl: string | undefined): Promise<RequestService>;
  /** The signed-in login on a host, cached for an hour; undefined when it will not say. */
  viewer(kind: RequestService, host: string): Promise<string | undefined>;
  /** The provider the user chose per host, for servers whose name says nothing. */
  hosts(): Promise<Record<string, RequestService>>;
  setHost(host: string, kind: RequestService | undefined): Promise<Record<string, RequestService>>;
  tools: ProviderTools;
}

type ProviderFactory = (tools: ProviderTools, env: Record<string, string | undefined>) => SourceControlProvider;

const FACTORIES: Record<RequestService, ProviderFactory> = {
  github: (tools) => createGitHubProvider(tools),
  gitlab: (tools) => createGitLabProvider(tools),
  forgejo: (tools) => createForgejoProvider(tools),
  bitbucket: (tools, env) => createBitbucketProvider(tools, env),
  "azure-devops": (tools) => createAzureProvider(tools),
};

/** `host` or `host:port`, lower-cased; what the setting is keyed by. */
export function normalizeHost(value: string): string | undefined {
  const raw = value.trim().toLowerCase();
  const host = remoteHost(raw.includes("://") ? raw : `https://${raw}`);
  return host && /^[a-z0-9.-]+(?::\d+)?$/u.test(host) && host.includes(".") ? host : undefined;
}

function firstLine(text: string): string {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const error = raw.error && typeof raw.error === "object" ? raw.error as Record<string, unknown> : raw;
    for (const key of ["message", "detail", "error_description"]) {
      if (typeof error[key] === "string" && error[key]) return error[key] as string;
    }
  } catch { /* not JSON */ }
  return text.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
}

export function createSourceControl(context: HostExtensionContext, options: SourceControlOptions = {}): SourceControl {
  const { services } = context;
  const run = options.run ?? defaultCliRunner;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const fetchImpl: HttpFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const gate = new RateLimitGate(now);
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  const viewers = new Map<string, { at: number; login: Promise<string | undefined> }>();
  const credentials = new Map<string, { at: number; value: Promise<GitCredential | undefined> }>();
  let hostChoices: Promise<Record<string, RequestService>> | undefined;
  const hostsPath = join(services.stateDir, HOSTS_FILE);

  const readHosts = async (): Promise<Record<string, RequestService>> => {
    try {
      const raw = JSON.parse(await readFile(hostsPath, "utf8")) as { hosts?: Record<string, unknown> };
      return Object.fromEntries(Object.entries(raw.hosts ?? {}).flatMap(([host, kind]) => {
        const key = normalizeHost(host);
        return key && REQUEST_SERVICES.includes(kind as RequestService) ? [[key, kind as RequestService]] : [];
      }));
    } catch {
      return {};
    }
  };

  const cli: ProviderTools["cli"] = async (kind, call, action, extra = {}) => {
    const facts = SERVICES[kind];
    const command = services.findCommand(facts.tool);
    if (!command) throw new HostCommandError(`${facts.label} is not installed or not on your PATH. Install it from ${facts.install}, then run \`${facts.login}\`.`);
    if (extra.host) gate.check(providerInfo(kind).name, kind, extra.host);
    services.noteSubprocess();
    try {
      // A call that names its repository needs no checkout to run in.
      let stderr = "";
      const output = await run(command, call.args, extra.cwd ?? homedir(), {
        ...(call.input !== undefined ? { input: call.input } : {}),
        ...(extra.maxBuffer ? { maxBuffer: extra.maxBuffer } : {}),
        ...(extra.inspect ? { onStderr: (text: string) => { stderr = text; } } : {}),
      });
      extra.inspect?.(output, stderr);
      if (extra.host) gate.succeeded(kind, extra.host);
      return output;
    } catch (error) {
      if (extra.host && error instanceof Error && isRateLimited(error.message)) gate.record(kind, extra.host);
      throw new HostCommandError(explainCliFailure(kind, action, error));
    }
  };

  const http: ProviderTools["http"] = async (kind, url, init) => {
    gate.check(providerInfo(kind).name, kind, init.host);
    let answer: HttpAnswer;
    try {
      answer = await fetchImpl(url, {
        method: init.method ?? "GET",
        headers: { Accept: "application/json", ...init.headers },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        redirect: "follow",
      });
    } catch (error) {
      throw new HostCommandError(`${init.action} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const limited = answer.status === 429 || (answer.status === 403 && answer.headers.get("x-ratelimit-remaining") === "0");
    if (limited) gate.record(kind, init.host, retryAtFrom(answer.headers, now()));
    if (answer.status < 200 || answer.status >= 300) {
      const detail = firstLine(await answer.text().catch(() => ""));
      throw new HostCommandError(explainCliFailure(kind, init.action, new Error(`HTTP ${answer.status}${limited ? " rate limit" : ""}${detail ? `: ${detail}` : ""}`)));
    }
    gate.succeeded(kind, init.host);
    return answer;
  };

  /** Git's own helper, asked like `git credential fill` with every prompt switched off; read only, never stored. */
  const credential: ProviderTools["credential"] = (host) => {
    const held = credentials.get(host);
    if (held && now() - held.at < CREDENTIAL_TTL_MS) return held.value;
    const value = (async (): Promise<GitCredential | undefined> => {
      const git = services.findCommand("git");
      if (!git) return undefined;
      services.noteSubprocess();
      const output = await run(git, ["-c", "core.askPass=", "credential", "fill"], homedir(), {
        input: `protocol=https\nhost=${host}\n\n`,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GCM_INTERACTIVE: "never" },
      }).catch(() => "");
      const fields = new Map(output.split(/\r?\n/u).flatMap((line) => {
        const at = line.indexOf("=");
        return at > 0 ? [[line.slice(0, at), line.slice(at + 1)] as const] : [];
      }));
      const username = fields.get("username");
      const password = fields.get("password");
      return username && password ? { username, password } : undefined;
    })();
    credentials.set(host, { at: now(), value });
    void value.then((found) => { if (!found && credentials.get(host)?.value === value) credentials.delete(host); });
    return value;
  };

  const tools: ProviderTools = {
    findCommand: (name) => services.findCommand(name),
    log: (event, detail) => services.log(event, detail),
    cli,
    http,
    credential,
    cached: <T>(kind: string, ref: PullRequestRef, fresh: boolean, read: () => Promise<T>): Promise<T> => {
      const key = `${kind}\0${ref.url}`;
      const entry = cache.get(key);
      if (entry && !fresh && now() - entry.at < READ_TTL_MS) return entry.value as Promise<T>;
      const value = read();
      cache.set(key, { at: now(), value });
      value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
      return value;
    },
    drop: (kind, ref) => { cache.delete(`${kind}\0${ref.url}`); },
    forget: (ref) => { for (const key of cache.keys()) if (key.endsWith(`\0${ref.url}`)) cache.delete(key); },
    workspace: async (command, input) => {
      try {
        return await context.invokeHostExtension(WORKSPACE_HOST_EXTENSION_ID, command, input);
      } catch (error) {
        throw new HostCommandError(error instanceof Error ? error.message : String(error));
      }
    },
    now,
  };

  const providers = new Map(REQUEST_SERVICES.map((kind) => [kind, FACTORIES[kind](tools, env)] as const));
  const get = (kind: RequestService) => providers.get(kind) ?? providers.get("github")!;
  const hosts = () => (hostChoices ??= readHosts());

  return {
    get,
    all: () => [...providers.values()],
    forUrl: (url) => {
      const ref = parseRequestUrl(url);
      return ref ? { provider: get(ref.service), ref } : undefined;
    },
    detect: async (remoteUrl) => serviceFor(remoteUrl, (name) => services.findCommand(name), await hosts()),
    viewer: (kind, host) => {
      const key = `${kind}\0${host}`;
      const held = viewers.get(key);
      if (held && now() - held.at < VIEWER_TTL_MS) return held.login;
      const login = get(kind).viewer(host).catch(() => undefined);
      viewers.set(key, { at: now(), login });
      void login.then((value) => { if (value === undefined && viewers.get(key)?.login === login) viewers.delete(key); });
      return login;
    },
    hosts,
    setHost: async (host, kind) => {
      const key = normalizeHost(host);
      if (!key) throw new HostCommandError("Name the server by its host, such as git.example.com.");
      const next = { ...await hosts() };
      if (kind) next[key] = kind; else delete next[key];
      await mkdir(services.stateDir, { recursive: true });
      const temporary = `${hostsPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, hosts: next }, null, 2)}\n`);
      await rename(temporary, hostsPath);
      hostChoices = Promise.resolve(next);
      return next;
    },
    tools,
  };
}
