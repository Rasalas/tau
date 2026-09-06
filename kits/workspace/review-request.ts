import { execFile } from "node:child_process";
import type { UiReviewRequest } from "tau/host-extension";

/** Runs a host tool in a checkout and resolves its stdout; rejects on any failure. */
export type ToolRunner = (command: string, args: string[], cwd: string) => Promise<string>;

export interface ReviewRequestTools {
  /** Absolute path of `gh`, `glab` or `git` on the login shell's PATH, or undefined. */
  findCommand(name: string): string | undefined;
  run?: ToolRunner;
  onSubprocess?(): void;
  /** How long a detected request stays valid for the same checkout and branch. */
  cacheMs?: number;
  now?(): number;
}

const TOOL_TIMEOUT_MS = 8_000;

const defaultRunner: ToolRunner = (command, args, cwd) => new Promise((resolve, reject) => {
  execFile(command, args, {
    cwd,
    timeout: TOOL_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    // Both CLIs would otherwise prompt for a login or a remote choice.
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GLAB_NO_PROMPT: "1", NO_COLOR: "1", CI: "1" },
  }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `gh pr view --json …` for the current branch. */
export function parseGitHubPullRequest(output: string): UiReviewRequest | undefined {
  const raw = JSON.parse(output) as Record<string, unknown>;
  const number = asNumber(raw.number);
  const baseRef = asString(raw.baseRefName);
  const url = asString(raw.url);
  if (number === undefined || !baseRef || !url) return undefined;
  return { provider: "github", number, title: asString(raw.title) ?? `#${number}`, url, baseRef, ...(asString(raw.headRefName) ? { headRef: asString(raw.headRefName) } : {}) };
}

/** `glab mr view -F json` for the current branch. */
export function parseGitLabMergeRequest(output: string): UiReviewRequest | undefined {
  const raw = JSON.parse(output) as Record<string, unknown>;
  const number = asNumber(raw.iid);
  const baseRef = asString(raw.target_branch);
  const url = asString(raw.web_url);
  if (number === undefined || !baseRef || !url) return undefined;
  return { provider: "gitlab", number, title: asString(raw.title) ?? `!${number}`, url, baseRef, ...(asString(raw.source_branch) ? { headRef: asString(raw.source_branch) } : {}) };
}

const PROVIDERS = {
  github: { tool: "gh", args: ["pr", "view", "--json", "number,title,url,baseRefName,headRefName"], parse: parseGitHubPullRequest },
  gitlab: { tool: "glab", args: ["mr", "view", "-F", "json"], parse: parseGitLabMergeRequest },
} as const;

/** Which hosting service to ask first, from the origin URL; both are tried when it says nothing. */
export function providerOrder(remoteUrl: string | undefined): Array<keyof typeof PROVIDERS> {
  const url = (remoteUrl ?? "").toLowerCase();
  if (url.includes("gitlab")) return ["gitlab", "github"];
  if (url.includes("github")) return ["github", "gitlab"];
  return ["github", "gitlab"];
}

/**
 * Finds the pull or merge request of a checkout's current branch through the
 * installed `gh` or `glab`. A missing tool, a branch without a request, a
 * remote the CLI does not serve or a missing login all answer undefined; the
 * caller falls back to plain Git. Results are cached briefly per branch.
 */
export function createReviewRequestDetector(tools: ReviewRequestTools): { detect(cwd: string): Promise<UiReviewRequest | undefined> } {
  const run: ToolRunner = tools.run ?? defaultRunner;
  const now = tools.now ?? Date.now;
  const cacheMs = tools.cacheMs ?? 30_000;
  const cache = new Map<string, { at: number; value: UiReviewRequest | undefined }>();

  const git = async (cwd: string, args: string[]): Promise<string> => {
    tools.onSubprocess?.();
    return (await run(tools.findCommand("git") ?? "git", args, cwd).catch(() => "")).trim();
  };

  return {
    async detect(cwd) {
      const branch = await git(cwd, ["branch", "--show-current"]);
      if (!branch) return undefined;
      const key = `${cwd}\0${branch}`;
      const cached = cache.get(key);
      if (cached && now() - cached.at < cacheMs) return cached.value;
      const remote = await git(cwd, ["remote", "get-url", "origin"]);
      let value: UiReviewRequest | undefined;
      for (const provider of providerOrder(remote)) {
        const { tool, args, parse } = PROVIDERS[provider];
        const command = tools.findCommand(tool);
        if (!command) continue;
        tools.onSubprocess?.();
        try {
          value = parse(await run(command, [...args], cwd));
        } catch {
          continue;
        }
        if (value) break;
      }
      cache.set(key, { at: now(), value });
      return value;
    },
  };
}
