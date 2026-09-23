import { execFile } from "node:child_process";
import { commandInvocation } from "tau/host-extension";
import type { MergeMethod, RequestService } from "./protocol.js";

/**
 * Runs a hosting CLI in a checkout and resolves its stdout; rejects with its
 * stderr. `input` goes to stdin, so a comment's text never lands in argv.
 */
export type CliRunner = (command: string, args: string[], cwd: string, options?: CliRunOptions) => Promise<string>;

export interface CliRunOptions {
  input?: string;
  /** Bytes of stdout accepted; 2 MiB unless a caller expects a diff. */
  maxBuffer?: number;
  /** Added to the environment, e.g. to keep Git from prompting. */
  env?: Record<string, string>;
  /** Hears stderr of a call that succeeded; `tea api` reports the HTTP status there. */
  onStderr?(stderr: string): void;
}

const CLI_TIMEOUT_MS = 25_000;

export const defaultCliRunner: CliRunner = (command, args, cwd, options = {}) => new Promise((resolve, reject) => {
  const invocation = commandInvocation(command, args);
  const child = execFile(invocation.command, invocation.args, {
    cwd,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    // No CLI may stop for a prompt: there is no terminal to answer it.
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GLAB_NO_PROMPT: "1", NO_COLOR: "1", AZURE_CORE_ONLY_SHOW_ERRORS: "1", AZURE_CORE_NO_COLOR: "1", ...options.env },
  }, (error, stdout, stderr) => {
    if (!error) { options.onStderr?.(String(stderr)); resolve(stdout); return; }
    // Past maxBuffer, stdout holds a cut-off answer rather than a reason.
    const overflow = (error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    const detail = overflow ? error.message : String(stderr || stdout || "").trim() || error.message;
    reject(new Error(detail));
  });
  if (options.input !== undefined) child.stdin?.end(options.input);
});

export interface ServiceFacts {
  /** The program the provider runs; Bitbucket's is Git, for its credential helper. */
  tool: string;
  /** How the user recognizes the tool in a message. */
  label: string;
  install: string;
  login: string;
  /** "pull request" or "merge request". */
  noun: string;
  short: "PR" | "MR";
}

export const SERVICES: Record<RequestService, ServiceFacts> = {
  github: { tool: "gh", label: "GitHub CLI (gh)", install: "https://cli.github.com", login: "gh auth login", noun: "pull request", short: "PR" },
  gitlab: { tool: "glab", label: "GitLab CLI (glab)", install: "https://gitlab.com/gitlab-org/cli", login: "glab auth login", noun: "merge request", short: "MR" },
  forgejo: { tool: "tea", label: "Gitea CLI (tea)", install: "https://gitea.com/gitea/tea", login: "tea login add", noun: "pull request", short: "PR" },
  bitbucket: {
    tool: "git", label: "Git's credential helper for Bitbucket", install: "https://git-scm.com",
    login: "printf 'protocol=https\\nhost=api.bitbucket.org\\nusername=<email>\\npassword=<API token>\\n' | git credential approve",
    noun: "pull request", short: "PR",
  },
  "azure-devops": { tool: "az", label: "Azure CLI (az)", install: "https://learn.microsoft.com/cli/azure/install-azure-cli", login: "az login", noun: "pull request", short: "PR" },
};

/** The host a remote URL names, lower-cased with its port: `git@host:o/r`, `ssh://git@host:22/o/r`, `https://host/o/r`. */
export function remoteHost(remoteUrl: string | undefined): string | undefined {
  const value = remoteUrl?.trim();
  if (!value) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)/u.exec(value);
    return scp?.[1]?.toLowerCase();
  }
  try {
    return new URL(value).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

const hasLabel = (hostname: string, label: string) => hostname.split(".").includes(label);

/** The provider a host is known to run, by its name alone; undefined for a name that says nothing. */
export function knownService(host: string): RequestService | undefined {
  const hostname = host.replace(/:\d+$/u, "");
  if (hostname === "codeberg.org" || hasLabel(hostname, "forgejo") || hasLabel(hostname, "gitea")) return "forgejo";
  if (hostname === "github.com" || hasLabel(hostname, "github")) return "github";
  if (hostname === "gitlab.com" || hasLabel(hostname, "gitlab")) return "gitlab";
  // `ssh.dev.azure.com` and `vs-ssh.visualstudio.com` are the SSH hosts.
  if (hostname === "dev.azure.com" || hostname.endsWith(".dev.azure.com") || hostname.endsWith(".visualstudio.com")) return "azure-devops";
  if (hostname === "bitbucket.org" || hasLabel(hostname, "bitbucket")) return "bitbucket";
  return undefined;
}

/**
 * The provider a remote belongs to: the user's choice for its host first,
 * then what the host's name says, and for any other remote whichever CLI is
 * installed (gh first).
 */
export function serviceFor(remoteUrl: string | undefined, findCommand: (name: string) => string | undefined, hosts: Readonly<Record<string, RequestService>> = {}): RequestService {
  const host = remoteHost(remoteUrl);
  const chosen = host ? hosts[host] ?? hosts[host.replace(/:\d+$/u, "")] : undefined;
  if (chosen) return chosen;
  const known = host ? knownService(host) : undefined;
  if (known) return known;
  if (!findCommand("gh") && findCommand("glab")) return "gitlab";
  return "github";
}

export function authArgs(): string[] {
  return ["auth", "status"];
}

export function createArgs(service: RequestService, input: { title: string; body: string; base: string; head: string; draft: boolean }): string[] {
  return service === "github"
    ? ["pr", "create", "--title", input.title, "--body", input.body, "--base", input.base, "--head", input.head, ...(input.draft ? ["--draft"] : [])]
    : ["mr", "create", "--title", input.title, "--description", input.body, "--target-branch", input.base, "--source-branch", input.head, "--yes", ...(input.draft ? ["--draft"] : [])];
}

export function mergeArgs(service: RequestService, number: number, method: MergeMethod): string[] {
  if (service === "github") return ["pr", "merge", String(number), `--${method}`];
  return ["mr", "merge", String(number), "--yes", ...(method === "squash" ? ["--squash"] : method === "rebase" ? ["--rebase"] : [])];
}

export function editArgs(service: RequestService, number: number, input: { title?: string; body?: string }): string[] {
  const title = input.title === undefined ? [] : ["--title", input.title];
  if (service === "github") return ["pr", "edit", String(number), ...title, ...(input.body === undefined ? [] : ["--body", input.body])];
  return ["mr", "update", String(number), ...title, ...(input.body === undefined ? [] : ["--description", input.body])];
}

export function draftArgs(service: RequestService, number: number, draft: boolean): string[] {
  if (service === "github") return ["pr", "ready", String(number), ...(draft ? ["--undo"] : [])];
  return ["mr", "update", String(number), draft ? "--draft" : "--ready"];
}

/** The URL a create command printed, if it printed one. */
export function createdUrl(output: string): string | undefined {
  return /https?:\/\/\S+/u.exec(output)?.[0];
}

/**
 * Turns a CLI failure into a sentence that says what is missing. The tools
 * word the same problem differently across versions, so this matches loosely
 * and otherwise passes the tool's own first line through.
 */
export function explainCliFailure(service: RequestService, action: string, error: unknown): string {
  const facts = SERVICES[service];
  const text = error instanceof Error ? error.message : String(error);
  if (/rate limit|HTTP 429|too many requests/iu.test(text)) return `${action} failed: the host's rate limit is reached; Tau waits before it asks again.`;
  if (/auth login|not logged|logged in to no|authenticat|bad credentials|HTTP 401|401 Unauthorized|token is invalid|no token|az login|az devops login|tea login|no matching login/iu.test(text)) {
    return `${facts.label} is not signed in. Run \`${facts.login}\` in a terminal, then try again.`;
  }
  if (/no git remotes|none of the git remotes|could not determine (the )?(base )?repo|no known (GitHub|GitLab)|not a (GitHub|GitLab)/iu.test(text)) {
    return `${facts.label} does not know this repository's remote. Point the remote at ${service === "github" ? "GitHub" : "GitLab"} or run \`${facts.tool} repo set-default\`.`;
  }
  if (/already exists/iu.test(text)) return `A ${facts.noun} for this branch already exists.`;
  const line = text.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean) ?? "unknown error";
  return `${action} failed: ${line}`;
}

export type RepositoryVisibility = "private" | "public";
export type RemoteProtocol = "https" | "ssh";

/** `owner/name` or `name`; GitLab also takes `group/subgroup/name`. Nothing that could read as an option. */
export function isRepositoryPath(value: string): boolean {
  return /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)*$/u.test(value) && !value.endsWith(".git");
}

export function accountArgs(service: RequestService): string[] {
  return service === "github" ? ["api", "user", "--jq", ".login"] : ["api", "user"];
}

/** The account a CLI is signed in as, from `accountArgs`' answer. */
export function parseAccount(service: RequestService, output: string): string | undefined {
  if (service === "github") return output.trim() || undefined;
  try {
    const user = JSON.parse(output) as { username?: unknown };
    return typeof user.username === "string" && user.username ? user.username : undefined;
  } catch {
    return undefined;
  }
}

/** Both CLIs keep the protocol their clones use; the new remote follows it. */
export function protocolArgs(): string[] {
  return ["config", "get", "git_protocol"];
}

export function createRepositoryArgs(repository: string, visibility: RepositoryVisibility): string[] {
  return ["repo", "create", repository, `--${visibility}`];
}

export function gitlabNamespaceArgs(namespace: string): string[] {
  return ["api", `namespaces/${encodeURIComponent(namespace)}`];
}

export function gitlabCreateProjectArgs(path: string, visibility: RepositoryVisibility, namespaceId?: number): string[] {
  return [
    "api", "--method", "POST", "projects",
    "--raw-field", `path=${path}`,
    "--raw-field", `name=${path}`,
    "--raw-field", `visibility=${visibility}`,
    ...(namespaceId === undefined ? [] : ["--raw-field", `namespace_id=${namespaceId}`]),
  ];
}

export interface CreatedRepository {
  /** `owner/name` as the host spells it. */
  nameWithOwner: string;
  web: string;
  https: string;
  ssh: string;
}

/** What `gh repo create` printed: its web URL, from which the clone URLs follow. */
export function githubCreatedRepository(output: string, repository: string): CreatedRepository | undefined {
  const printed = /https?:\/\/\S+/u.exec(output)?.[0]?.replace(/\.git$/u, "");
  try {
    const url = new URL(printed ?? "");
    const [owner, name, ...rest] = url.pathname.split("/").filter(Boolean);
    if (!owner || !name || rest.length > 0) return undefined;
    return { nameWithOwner: `${owner}/${name}`, web: `${url.origin}/${owner}/${name}`, https: `${url.origin}/${owner}/${name}.git`, ssh: `git@${url.host}:${owner}/${name}.git` };
  } catch {
    return repository.includes("/")
      ? { nameWithOwner: repository, web: `https://github.com/${repository}`, https: `https://github.com/${repository}.git`, ssh: `git@github.com:${repository}.git` }
      : undefined;
  }
}

/** The project GitLab's API answered with. */
export function gitlabCreatedRepository(output: string): CreatedRepository | undefined {
  try {
    const project = JSON.parse(output) as Record<string, unknown>;
    const field = (key: string) => (typeof project[key] === "string" && project[key] ? project[key] as string : undefined);
    const nameWithOwner = field("path_with_namespace");
    const web = field("web_url");
    const https = field("http_url_to_repo");
    const ssh = field("ssh_url_to_repo");
    return nameWithOwner && web && https && ssh ? { nameWithOwner, web, https, ssh } : undefined;
  } catch {
    return undefined;
  }
}
