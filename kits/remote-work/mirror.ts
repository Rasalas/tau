import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertAllowedCloneSource, HostCommandError } from "tau/host-extension";
import { branchBaseConfigKey } from "../workspace/agent-worktrees.js";
import { gitMessage, receivingGitRunner, type GitRunner } from "./git.js";
import { REPO_KEY, folderName } from "./identity.js";
import { DOWNLOAD_PIECE_BYTES, REMOTE_WORK_PROTOCOL, type PrepareResult, type RepoIdentity, type ResultAnswer, type TransferStepId, type TransferStepState } from "./protocol.js";

/** The receiving machine's own folder for remote work: mirrors, worktrees, outgoing bundles. */
export const defaultRemoteWorkRoot = () => join(homedir(), ".tau", "remote-work");

export const TRANSFER_ID = /^[a-z0-9]{8,40}$/u;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const MAX_TIPS = 1000;

/** A worktree this machine made for another machine's transfer (`<stateDir>/received.json`). */
export interface ReceivedWorktree {
  transfer: string;
  key: string;
  name: string;
  worktree: string;
  branch: string;
  base: string;
  /** The paired device that sent it; only that device (or this machine's owner) may read or remove it. */
  device?: string;
  createdAt: number;
  workspaceId?: string;
}

export type StepReport = (id: TransferStepId, state: TransferStepState, detail?: string) => void;

export interface MirrorStoreOptions {
  stateDir: string;
  root?: string;
  git?: GitRunner;
  /** For `assertAllowedCloneSource`: a test host lets `file://` through under its clone root. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** How long `git ls-remote` may take to say whether origin can be read from here. */
  lsRemoteTimeoutMs?: number;
}

export const transferBranch = (transfer: string) => `tau/remote-${transfer}`;
const incomingRef = (transfer: string) => `refs/tau/incoming/${transfer}`;
const resultRef = (transfer: string) => `refs/tau/result/${transfer}`;

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).once("error", reject).once("end", () => resolve(hash.digest("hex")));
  });
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * The receiving side's Git (plan-H §2): one bare mirror per project under
 * `~/.tau/remote-work/repos/<key>.git`, a worktree per transfer under
 * `worktrees/<name>/<transfer>`, the result as a bundle under `outgoing/`.
 * Nothing here touches a checkout of this machine's user, and no hook runs:
 * the mirror's own config points `core.hooksPath` at an empty folder, so a
 * thread's commits in the worktree skip them too.
 */
export class MirrorStore {
  readonly root: string;
  private readonly git: GitRunner;
  private readonly bookPath: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  private book?: ReceivedWorktree[];

  constructor(private readonly options: MirrorStoreOptions) {
    this.root = options.root ?? defaultRemoteWorkRoot();
    this.git = options.git ?? receivingGitRunner(this.noHooksDir, options.env);
    this.bookPath = join(options.stateDir, "received.json");
  }

  get noHooksDir(): string {
    return join(this.root, "no-hooks");
  }

  mirrorPath(key: string): string {
    if (!REPO_KEY.test(key)) throw new HostCommandError(`"${key}" is not a project key this machine takes.`);
    return join(this.root, "repos", `${key}.git`);
  }

  worktreePath(name: string, transfer: string): string {
    return join(this.root, "worktrees", folderName(name), transfer);
  }

  /** One Git sequence per mirror at a time; transfers of other projects run side by side. */
  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const before = this.locks.get(key) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(run);
    this.locks.set(key, next);
    void next.finally(() => { if (this.locks.get(key) === next) this.locks.delete(key); }).catch(() => undefined);
    return next;
  }

  private async load(): Promise<ReceivedWorktree[]> {
    if (!this.book) {
      try {
        const raw = JSON.parse(await readFile(this.bookPath, "utf8")) as unknown;
        this.book = Array.isArray(raw) ? raw.filter((entry): entry is ReceivedWorktree => typeof entry?.transfer === "string" && typeof entry?.worktree === "string") : [];
      } catch {
        this.book = [];
      }
    }
    return this.book;
  }

  private async save(): Promise<void> {
    await mkdir(this.options.stateDir, { recursive: true });
    const temporary = `${this.bookPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.book ?? [], null, 1)}\n`, { mode: 0o600 });
    await rename(temporary, this.bookPath);
  }

  async list(): Promise<ReceivedWorktree[]> {
    return [...await this.load()];
  }

  /** A transfer's worktree, for the device that sent it or this machine's owner. */
  async get(transfer: string, device?: string): Promise<ReceivedWorktree> {
    const found = (await this.load()).find((entry) => entry.transfer === transfer);
    if (!found || (found.device && device && found.device !== device)) throw new HostCommandError(`This machine has no worktree for transfer ${transfer}.`);
    return found;
  }

  /** Whether origin answers from here with this machine's own credentials, within the time given. */
  private async originReadable(origin: string | undefined): Promise<boolean> {
    if (!origin) return false;
    try {
      assertAllowedCloneSource(origin, this.options.env ?? process.env);
    } catch {
      return false;
    }
    return this.git(this.root, ["ls-remote", "--heads", "--", origin], { timeoutMs: this.options.lsRemoteTimeoutMs ?? 20_000 }).then(() => true, () => false);
  }

  /**
   * The mirror for `repo`, made or brought up to date: cloned from origin when
   * this machine can read it, else empty, and fetched from origin when it has
   * one. Answers the commits its refs point at, so the bundle can leave out
   * everything they reach.
   */
  prepare(repo: RepoIdentity, step: StepReport): Promise<PrepareResult & { detail: string }> {
    const mirror = this.mirrorPath(repo.key);
    return this.serial(repo.key, async () => {
      await mkdir(this.noHooksDir, { recursive: true });
      let state: PrepareResult["mirror"];
      let detail: string;
      if (await exists(join(mirror, "HEAD"))) {
        const origin = (await this.git(mirror, ["config", "--get", "remote.origin.url"]).catch(() => "")).trim();
        if (origin) {
          step("mirror", "running", "Fetching origin");
          const fetched = await this.git(mirror, ["fetch", "--quiet", "--no-tags", "origin"], { timeoutMs: 5 * 60_000 }).then(() => true, () => false);
          state = fetched ? "fetched" : "kept";
          detail = fetched ? "Mirror updated from origin" : "Origin did not answer; the mirror stays as it was";
        } else {
          state = "kept";
          detail = "Mirror kept; it has no origin to read";
        }
      } else {
        await mkdir(join(this.root, "repos"), { recursive: true });
        const temporary = `${mirror}.tmp-${process.pid}-${Date.now()}`;
        await rm(temporary, { recursive: true, force: true });
        try {
          if (await this.originReadable(repo.origin)) {
            step("mirror", "running", "Cloning origin");
            await this.git(this.root, ["clone", "--bare", "--quiet", "--no-tags", "--template=", "--", repo.origin!, temporary], { timeoutMs: 60 * 60_000 });
            // Later fetches keep origin's branches apart from the worktrees' own.
            await this.git(temporary, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
            state = "cloned";
            detail = "Cloned from origin";
          } else {
            await this.git(this.root, ["init", "--bare", "--quiet", "--template=", temporary]);
            state = "empty";
            detail = repo.origin ? "Origin is not readable from here; everything comes in the bundle" : "New mirror; everything comes in the bundle";
          }
          await this.git(temporary, ["config", "core.hooksPath", this.noHooksDir]);
          await this.git(temporary, ["config", "gc.autoDetach", "false"]);
          await rename(temporary, mirror);
        } catch (error) {
          await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
          throw new Error(`The mirror could not be made: ${gitMessage(error)}`, { cause: error });
        }
      }
      const tips = (await this.git(mirror, ["for-each-ref", "--sort=-committerdate", `--count=${MAX_TIPS}`, "--format=%(objectname)", "refs/heads", "refs/remotes", "refs/tau/incoming", "refs/tau/result"]))
        .split("\n").map((line) => line.trim()).filter((line) => SHA.test(line));
      return { protocol: REMOTE_WORK_PROTOCOL, tips: [...new Set(tips)], mirror: state, detail };
    });
  }

  /**
   * Takes a transfer's state into the mirror — from the bundle, or from what
   * it has when the bundle was not needed — and checks it out on a branch of
   * its own. The bundle is verified before a single object is fetched.
   */
  receive(input: { transfer: string; repo: RepoIdentity; base: string; bundle?: string; device?: string }, step: StepReport): Promise<ReceivedWorktree> {
    const { transfer, repo, base } = input;
    if (!TRANSFER_ID.test(transfer) || !SHA.test(base)) throw new HostCommandError("A transfer needs its id and the commit it carries.");
    const mirror = this.mirrorPath(repo.key);
    return this.serial(repo.key, async () => {
      if (!await exists(join(mirror, "HEAD"))) throw new HostCommandError("This machine has no mirror of the project yet; prepare it first.");
      if ((await this.load()).some((entry) => entry.transfer === transfer)) throw new HostCommandError(`Transfer ${transfer} arrived here already.`);
      step("unpack", "running", input.bundle ? "Checking the bundle" : "Looking for the commit");
      if (input.bundle) {
        try {
          await this.git(mirror, ["bundle", "verify", "--quiet", input.bundle], { timeoutMs: 10 * 60_000 });
        } catch (error) {
          throw new Error(`The bundle does not fit this machine's mirror: ${gitMessage(error)}`, { cause: error });
        }
        await this.git(mirror, ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", input.bundle, `+refs/tau/transfer/${transfer}:${incomingRef(transfer)}`], { timeoutMs: 30 * 60_000 });
      } else {
        await this.git(mirror, ["cat-file", "-e", `${base}^{commit}`]).catch((error) => {
          throw new Error(`This machine's mirror does not have ${base.slice(0, 12)}, and no bundle came with it.`, { cause: error });
        });
        await this.git(mirror, ["update-ref", incomingRef(transfer), base]);
      }
      const arrived = (await this.git(mirror, ["rev-parse", "--verify", incomingRef(transfer)])).trim();
      if (arrived !== base) throw new Error(`The bundle carried ${arrived.slice(0, 12)}, not ${base.slice(0, 12)}.`);
      step("unpack", "done", input.bundle ? "Bundle verified and fetched" : "The mirror had every commit");

      const worktree = this.worktreePath(repo.name, transfer);
      const branch = transferBranch(transfer);
      step("worktree", "running", "Checking out");
      if (await exists(worktree)) throw new Error(`${worktree} exists already.`);
      await mkdir(join(worktree, ".."), { recursive: true });
      await this.git(mirror, ["worktree", "add", "--quiet", "--no-track", "-b", branch, worktree, base], { timeoutMs: 30 * 60_000 });
      await this.git(mirror, ["config", branchBaseConfigKey(branch), base]);
      step("worktree", "done", worktree);
      const entry: ReceivedWorktree = {
        transfer, key: repo.key, name: repo.name, worktree, branch, base, createdAt: (this.options.now ?? Date.now)(),
        ...(input.device ? { device: input.device } : {}),
      };
      (await this.load()).push(entry);
      await this.save();
      return entry;
    });
  }

  async remember(transfer: string, patch: Partial<Pick<ReceivedWorktree, "workspaceId">>): Promise<void> {
    const entry = (await this.load()).find((candidate) => candidate.transfer === transfer);
    if (!entry) return;
    Object.assign(entry, patch);
    await this.save();
  }

  private outgoingPath(transfer: string): string {
    return join(this.root, "outgoing", `${transfer}.bundle`);
  }

  /**
   * What was done in the worktree, as a bundle of `base..HEAD`: uncommitted
   * work is committed first as "tau: result". A worktree still at `base`
   * answers `nothing`.
   */
  async result(transfer: string, device?: string): Promise<ResultAnswer> {
    const entry = await this.get(transfer, device);
    const mirror = this.mirrorPath(entry.key);
    return this.serial(entry.key, async () => {
      const { worktree, base } = entry;
      if (!await exists(worktree)) throw new HostCommandError(`The worktree of transfer ${transfer} is gone from this machine.`);
      const dirty = (await this.git(worktree, ["status", "--porcelain", "-z"])).length > 0;
      if (dirty) {
        const identity = await this.identityArgs(worktree);
        await this.git(worktree, ["add", "-A"]);
        await this.git(worktree, [...identity, "commit", "--quiet", "--no-verify", "-m", "tau: result"]);
      }
      const tip = (await this.git(worktree, ["rev-parse", "--verify", "HEAD"])).trim();
      await rm(this.outgoingPath(transfer), { force: true });
      if (tip === base) return { state: "nothing", tip };
      await this.git(mirror, ["update-ref", resultRef(transfer), tip]);
      const commits = Number((await this.git(mirror, ["rev-list", "--count", tip, `^${base}`])).trim()) || 0;
      const files = (await this.git(mirror, ["diff", "--name-only", "-z", base, tip])).split("\0").filter(Boolean).length;
      await mkdir(join(this.root, "outgoing"), { recursive: true });
      const path = this.outgoingPath(transfer);
      await this.git(mirror, ["bundle", "create", "--quiet", path, "--stdin"], { stdin: `${resultRef(transfer)}\n^${base}\n`, timeoutMs: 30 * 60_000 });
      const size = (await stat(path)).size;
      return { state: "bundle", tip, commits, files, size, sha256: await sha256File(path) };
    });
  }

  /** A piece of the result bundle, as base64; the sending side pulls, this side never sends on its own. */
  async readResult(transfer: string, device: string | undefined, offset: number, length: number): Promise<string> {
    await this.get(transfer, device);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0 || length > DOWNLOAD_PIECE_BYTES) {
      throw new HostCommandError(`A piece is 1 to ${DOWNLOAD_PIECE_BYTES} bytes from a whole offset.`);
    }
    const handle = await open(this.outgoingPath(transfer), "r").catch(() => {
      throw new HostCommandError(`Transfer ${transfer} has no result bundle here; ask for the result first.`);
    });
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead).toString("base64");
    } finally {
      await handle.close();
    }
  }

  /** Removes a transfer's worktree, its branch, its refs and its bundle; the mirror stays for the next one. */
  async remove(transfer: string, device?: string): Promise<void> {
    const entry = await this.get(transfer, device);
    const mirror = this.mirrorPath(entry.key);
    await this.serial(entry.key, async () => {
      if (await exists(entry.worktree)) await this.git(mirror, ["worktree", "remove", "--force", "--force", entry.worktree]).catch(() => "");
      await rm(entry.worktree, { recursive: true, force: true });
      await this.git(mirror, ["worktree", "prune"]).catch(() => "");
      await this.git(mirror, ["branch", "-D", entry.branch]).catch(() => "");
      for (const ref of [incomingRef(transfer), resultRef(transfer)]) await this.git(mirror, ["update-ref", "-d", ref]).catch(() => "");
      await rm(this.outgoingPath(transfer), { force: true });
      this.book = (await this.load()).filter((candidate) => candidate.transfer !== transfer);
      await this.save();
    });
  }

  /** This machine's Git identity, or Tau's when it has none: the result commit must not fail on it. */
  private async identityArgs(cwd: string): Promise<string[]> {
    const name = (await this.git(cwd, ["config", "user.name"]).catch(() => "")).trim();
    const email = (await this.git(cwd, ["config", "user.email"]).catch(() => "")).trim();
    return [...(name ? [] : ["-c", "user.name=Tau"]), ...(email ? [] : ["-c", "user.email=tau@localhost.invalid"])];
  }
}
