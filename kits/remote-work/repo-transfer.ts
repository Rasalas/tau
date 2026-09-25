import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError } from "tau/host-extension";
import { branchBaseConfigKey, captureWorktreeTree } from "../workspace/agent-worktrees.js";
import { asAgentRunner, gitMessage, type GitRunner } from "./git.js";
import { transferRef } from "./protocol.js";

/**
 * The sending side's Git (plan-H §2): the checkout's state becomes one commit
 * under `refs/tau/transfer/<id>`, the other machine gets a bundle of what its
 * mirror lacks, and what comes back is fetched from a bundle into a branch
 * `tau/<machine>/<slug>`. Nothing is ever pushed anywhere.
 */

export const TRANSFER_BRANCH_KEY = (branch: string) => `branch.${branch}.tau-transfer`;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

export interface CapturedState {
  head: string;
  /** HEAD itself when the checkout had nothing uncommitted, else a state commit on top of it. */
  base: string;
  dirty: boolean;
}

/** Git's own identity here, or Tau's when the repository has none: a commit Tau makes must not fail on it. */
export async function withIdentity(git: GitRunner, cwd: string): Promise<GitRunner> {
  const name = (await git(cwd, ["config", "user.name"]).catch(() => "")).trim();
  const email = (await git(cwd, ["config", "user.email"]).catch(() => "")).trim();
  const extra = [...(name ? [] : ["-c", "user.name=Tau"]), ...(email ? [] : ["-c", "user.email=tau@localhost.invalid"])];
  return extra.length === 0 ? git : (dir, args, options) => git(dir, [...extra, ...args], options);
}

/**
 * The checkout's state as one commit, like a spawned thread's start
 * (`createAgentWorktree`): the working copy through a private index —
 * uncommitted and untracked files alike, ignored ones not — or a checkpoint
 * tree, as a commit on HEAD. The user's index and files stay as they are.
 */
export async function captureTransferState(options: { root: string; transfer: string; machineName: string; snapshotRef?: string; git: GitRunner }): Promise<CapturedState> {
  const { root, transfer, git } = options;
  const head = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim();
  const tree = options.snapshotRef
    ? (await git(root, ["rev-parse", "--verify", "--quiet", `${options.snapshotRef}^{tree}`]).catch(() => "")).trim()
    : await captureWorktreeTree(root, asAgentRunner(git));
  if (!tree) throw new HostCommandError(`${options.snapshotRef} names no tree in this repository.`);
  const headTree = (await git(root, ["rev-parse", `${head}^{tree}`])).trim();
  const dirty = tree !== headTree;
  const base = dirty
    ? (await (await withIdentity(git, root))(root, ["commit-tree", "--no-gpg-sign", tree, "-p", head, "-m", `tau: state sent to ${options.machineName}`])).trim()
    : head;
  await git(root, ["update-ref", "-m", "tau: transfer", transferRef(transfer), base]);
  return { head, base, dirty };
}

/** Which of `candidates` this repository has as commits. */
export async function commitsWeHave(root: string, candidates: readonly string[], git: GitRunner): Promise<string[]> {
  const wanted = candidates.filter((sha) => SHA.test(sha));
  if (wanted.length === 0) return [];
  const output = await git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { stdin: `${wanted.join("\n")}\n` });
  return output.split("\n").map((line) => line.trim().split(" ")).filter(([sha, type]) => SHA.test(sha ?? "") && type === "commit").map(([sha]) => sha);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).once("error", reject).once("end", () => resolve(hash.digest("hex")));
  });
}

export interface TransferBundle {
  path: string;
  size: number;
  sha256: string;
  commits: number;
}

/**
 * A bundle of the transfer's commit without what the other side's tips
 * reach; `undefined` when they reach it all and nothing needs to travel.
 */
export async function createTransferBundle(options: { root: string; transfer: string; tips: readonly string[]; directory: string; git: GitRunner }): Promise<TransferBundle | undefined> {
  const { root, transfer, git } = options;
  const haves = await commitsWeHave(root, options.tips, git);
  const revisions = `${transferRef(transfer)}\n${haves.map((sha) => `^${sha}`).join("\n")}\n`;
  const commits = Number((await git(root, ["rev-list", "--count", "--stdin"], { stdin: revisions })).trim()) || 0;
  if (commits === 0) return undefined;
  const path = join(options.directory, `${transfer}.bundle`);
  await git(root, ["bundle", "create", "--quiet", path, "--stdin"], { stdin: revisions, timeoutMs: 30 * 60_000 });
  return { path, size: (await stat(path)).size, sha256: await sha256File(path), commits };
}

const slug = (value: string, fallback: string) =>
  value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40).replace(/-+$/u, "") || fallback;

/**
 * `tau/<machine>/<slug>` for a transfer's result: a branch another transfer
 * holds already gets a number, one this transfer made is reused.
 */
export async function resultBranchName(options: { root: string; machineName: string; name?: string; transfer: string; git: GitRunner }): Promise<string> {
  const { root, transfer, git } = options;
  const stem = `tau/${slug(options.machineName, "machine")}/${slug(options.name ?? "", transfer)}`;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = attempt === 1 ? stem : `${stem}-${attempt}`;
    const taken = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`]).then(() => true, () => false);
    if (!taken) return candidate;
    const owner = (await git(root, ["config", "--get", TRANSFER_BRANCH_KEY(candidate)]).catch(() => "")).trim();
    if (owner === transfer) return candidate;
  }
  throw new HostCommandError(`Every branch name under ${stem} is taken.`);
}

export interface StoredResult {
  branch: string;
  tip: string;
  commits: number;
  files: number;
}

/**
 * Takes the other side's result bundle into a real branch here, with the
 * transfer's commit as its `tau-base`. The bundle is verified against this
 * repository first: its only prerequisite is that commit.
 */
export async function storeResultBundle(options: { root: string; transfer: string; bundle: string; branch: string; base: string; git: GitRunner }): Promise<StoredResult> {
  const { root, transfer, bundle, branch, base, git } = options;
  try {
    await git(root, ["bundle", "verify", "--quiet", bundle]);
  } catch (error) {
    throw new Error(`The result bundle does not fit this repository: ${gitMessage(error)}`, { cause: error });
  }
  const heads = (await git(root, ["bundle", "list-heads", bundle])).split("\n").map((line) => line.trim().split(" ")[1]).filter(Boolean);
  const source = `refs/tau/result/${transfer}`;
  if (!heads.includes(source)) throw new Error(`The result bundle carries ${heads.join(", ") || "no ref"}, not ${source}.`);
  try {
    await git(root, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", bundle, `+${source}:refs/heads/${branch}`]);
  } catch (error) {
    throw new Error(`The result could not be taken into ${branch}: ${gitMessage(error)}`, { cause: error });
  }
  await git(root, ["config", branchBaseConfigKey(branch), base]);
  await git(root, ["config", TRANSFER_BRANCH_KEY(branch), transfer]);
  const tip = (await git(root, ["rev-parse", "--verify", `refs/heads/${branch}`])).trim();
  const commits = Number((await git(root, ["rev-list", "--count", tip, `^${base}`])).trim()) || 0;
  const files = (await git(root, ["diff", "--name-only", "-z", base, tip])).split("\0").filter(Boolean).length;
  return { branch, tip, commits, files };
}
