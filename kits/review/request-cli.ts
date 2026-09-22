import { execFile } from "node:child_process";
import type { MergeMethod, RequestService } from "./protocol.js";

/** Runs a hosting CLI in a checkout and resolves its stdout; rejects with its stderr. */
export type CliRunner = (command: string, args: string[], cwd: string) => Promise<string>;

const CLI_TIMEOUT_MS = 25_000;

export const defaultCliRunner: CliRunner = (command, args, cwd) => new Promise((resolve, reject) => {
  execFile(command, args, {
    cwd,
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    // Neither CLI may stop for a prompt: there is no terminal to answer it.
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", GLAB_NO_PROMPT: "1", NO_COLOR: "1" },
  }, (error, stdout, stderr) => {
    if (!error) { resolve(stdout); return; }
    const detail = String(stderr || stdout || "").trim() || error.message;
    reject(new Error(detail));
  });
});

export interface ServiceFacts {
  tool: "gh" | "glab";
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
};

/** The service a remote belongs to by its URL; for any other URL, whichever CLI is installed (gh first). */
export function serviceFor(remoteUrl: string | undefined, findCommand: (name: string) => string | undefined): RequestService {
  const url = (remoteUrl ?? "").toLowerCase();
  if (url.includes("gitlab")) return "gitlab";
  if (url.includes("github")) return "github";
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
  if (/auth login|not logged|logged in to no|authenticat|bad credentials|HTTP 401|401 Unauthorized|token is invalid|no token/iu.test(text)) {
    return `${facts.label} is not signed in. Run \`${facts.login}\` in a terminal, then try again.`;
  }
  if (/no git remotes|none of the git remotes|could not determine (the )?(base )?repo|no known (GitHub|GitLab)|not a (GitHub|GitLab)/iu.test(text)) {
    return `${facts.label} does not know this repository's remote. Point the remote at ${service === "github" ? "GitHub" : "GitLab"} or run \`${facts.tool} repo set-default\`.`;
  }
  if (/already exists/iu.test(text)) return `A ${facts.noun} for this branch already exists.`;
  const line = text.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean) ?? "unknown error";
  return `${action} failed: ${line}`;
}
