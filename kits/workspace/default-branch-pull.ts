import { readDefaultBranch, runGitCommand, type GitRunner } from "./workspace-git.js";

/** Why a checkout was left as it was; none of these touches it. */
export type FastForwardSkip =
  | "not-a-repository"
  | "detached"
  | "not-default-branch"
  | "no-upstream"
  | "dirty"
  | "fetch-failed"
  | "local-commits"
  | "diverged"
  | "up-to-date"
  | "recently-checked";

export type FastForwardOutcome =
  | { status: "pulled"; branch: string; upstream: string; commits: number; head: string }
  | { status: "skipped"; reason: FastForwardSkip; detail?: string };

const FETCH_TIMEOUT_MS = 60_000;
const defaultGit: GitRunner = (cwd, args, maxBuffer, signal) => runGitCommand(cwd, args, maxBuffer, signal, undefined, FETCH_TIMEOUT_MS);

/**
 * Keeps a checkout of the default branch current:
 * only on the default branch, only with an upstream, only with no
 * changed or untracked file and no local commit, and only as a fast-forward.
 * `merge --ff-only` is the one writing step and git itself refuses anything
 * but a fast-forward there; nothing here merges, rebases or resets.
 */
export async function fastForwardDefaultBranch(
  checkout: string,
  options: { runGit?: GitRunner; defaultBranch?: (checkout: string) => Promise<string> } = {},
): Promise<FastForwardOutcome> {
  const git = options.runGit ?? defaultGit;
  const read = (args: string[]) => git(checkout, args).then((out) => out.trim(), () => undefined);
  const skip = (reason: FastForwardSkip, detail?: string): FastForwardOutcome => ({ status: "skipped", reason, ...(detail ? { detail } : {}) });

  if (await read(["rev-parse", "--is-inside-work-tree"]) !== "true") return skip("not-a-repository");
  const branch = await read(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) return skip("detached");
  const defaultBranch = await (options.defaultBranch ?? ((path) => readDefaultBranch(path, git)))(checkout);
  if (branch !== defaultBranch) return skip("not-default-branch", `${branch} is not ${defaultBranch}`);
  const upstream = await read(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream) return skip("no-upstream");
  const dirty = async () => (await read(["status", "--porcelain", "-z", "--untracked-files=normal"])) !== "";
  if (await dirty()) return skip("dirty");

  const remote = await read(["config", "--get", `branch.${branch}.remote`]);
  if (remote && remote !== ".") {
    try {
      await git(checkout, ["fetch", "--prune", remote]);
    } catch (error) {
      return skip("fetch-failed", firstLine(error));
    }
  }
  const count = async (range: string) => Number(await read(["rev-list", "--count", range]) ?? "NaN");
  const ahead = await count("@{u}..HEAD");
  const behind = await count("HEAD..@{u}");
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return skip("diverged", "the upstream could not be compared");
  if (ahead > 0) return skip("local-commits", `${ahead} commit${ahead === 1 ? "" : "s"} not on ${upstream}`);
  if (behind === 0) return skip("up-to-date");
  const target = await read(["rev-parse", "--verify", "@{u}^{commit}"]);
  if (!target) return skip("diverged", `${upstream} does not resolve`);
  const isAncestor = await git(checkout, ["merge-base", "--is-ancestor", "HEAD", target]).then(() => true, () => false);
  if (!isAncestor) return skip("diverged");
  // Checked again right before the write: an agent may have touched the tree during the fetch.
  if (await dirty()) return skip("dirty");
  try {
    await git(checkout, ["merge", "--ff-only", "--no-stat", "--quiet", target]);
  } catch (error) {
    return skip("diverged", firstLine(error));
  }
  return { status: "pulled", branch, upstream, commits: behind, head: target };
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n").map((line) => line.trim()).find(Boolean) ?? "git failed";
}

/**
 * One attempt per checkout at a time and at most one a minute, whoever asks:
 * every window's focus and timer end up here.
 */
export class DefaultBranchPuller {
  private readonly inFlight = new Map<string, Promise<FastForwardOutcome>>();
  private readonly lastAttempt = new Map<string, number>();

  constructor(
    private readonly pull: (checkout: string) => Promise<FastForwardOutcome> = (checkout) => fastForwardDefaultBranch(checkout),
    private readonly now: () => number = Date.now,
    private readonly minIntervalMs = 60_000,
  ) {}

  run(checkout: string): Promise<FastForwardOutcome> {
    const running = this.inFlight.get(checkout);
    if (running) return running;
    const last = this.lastAttempt.get(checkout);
    if (last !== undefined && this.now() - last < this.minIntervalMs) return Promise.resolve({ status: "skipped", reason: "recently-checked" });
    this.lastAttempt.set(checkout, this.now());
    const attempt = this.pull(checkout).finally(() => this.inFlight.delete(checkout));
    this.inFlight.set(checkout, attempt);
    return attempt;
  }
}
