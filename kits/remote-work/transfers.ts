import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostCommandError, type HostMachine, type HostMachineServices, type HostReadiness } from "tau/host-extension";
import { mergeBranchIntoCheckout, previewBranchMerge } from "../workspace/agent-worktrees.js";
import { asAgentRunner, createGitRunner, type GitRunner } from "./git.js";
import { readRepoIdentity, type CheckoutIdentity } from "./identity.js";
import { collectIgnoredFiles, safeRelativePath, suggestIgnoredFiles } from "./ignored-files.js";
import {
  DOWNLOAD_PIECE_BYTES,
  OPERATION_EVENT,
  RECEIVING_COMMANDS,
  REMOTE_WORK_EXTENSION_ID,
  REMOTE_WORK_PROTOCOL,
  operationTopic,
  transferRef,
  type IgnoredFilesView,
  type OperationSnapshot,
  type PrepareResult,
  type ReceiveResult,
  type RepoTransfer,
  type ResultAnswer,
  type SendRepoInput,
  type TransferPreview,
  type TransferStep,
  type TransferStepId,
  type TransferStepState,
} from "./protocol.js";
import { captureTransferState, createTransferBundle, resultBranchName, storeResultBundle, withIdentity } from "./repo-transfer.js";

/** The receiving side keeps this much free for a worktree, besides the mirror. */
const MIN_FREE_BYTES = 1024 * 1024 * 1024;
const MAX_BOOK = 200;

export const TRANSFER_STEPS: ReadonlyArray<{ id: TransferStepId; label: string }> = [
  { id: "state", label: "This checkout's state" },
  { id: "check", label: "Git and space there" },
  { id: "mirror", label: "Mirror there" },
  { id: "bundle", label: "Bundle" },
  { id: "upload", label: "Send" },
  { id: "unpack", label: "Unpack there" },
  { id: "worktree", label: "Worktree there" },
  { id: "files", label: "Ignored files" },
  { id: "setup", label: "Setup" },
];

export interface RepoTransfersOptions {
  machines(): HostMachineServices | undefined;
  stateDir: string;
  git?: GitRunner;
  emit(transfer: RepoTransfer): void;
  log?(label: string, detail?: string): void;
  now?(): number;
  newId?(): string;
  /** How often the sending side asks for an operation it also watches. */
  pollMs?: number;
  /** How long the other machine may stay unreachable before a running operation counts as lost. */
  offlineGraceMs?: number;
  tmpDir?: string;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
function size(bytes: number): string {
  const units = ["KB", "MB", "GB", "TB"];
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.ceil(value)} KB` : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * The sending side of remote work: moves a checkout's state to another
 * machine, brings back what was done there as a branch, and merges it only
 * when that is clean (plan-H §2). Each transfer is a record in
 * `<stateDir>/transfers.json`, pushed to this machine's clients on every change.
 * H06's thread service starts a thread in `transfer.remote.path`.
 */
export class RepoTransfers {
  private readonly git: GitRunner;
  private book?: RepoTransfer[];
  private selections?: Record<string, { paths: string[]; updatedAt: number }>;
  private writing: Promise<unknown> = Promise.resolve();
  private readonly busy = new Set<string>();

  constructor(private readonly options: RepoTransfersOptions) {
    this.git = options.git ?? createGitRunner();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get bookPath(): string {
    return join(this.options.stateDir, "transfers.json");
  }

  private get selectionsPath(): string {
    return join(this.options.stateDir, "ignored-files.json");
  }

  private async load(): Promise<RepoTransfer[]> {
    if (!this.book) {
      try {
        const raw = JSON.parse(await readFile(this.bookPath, "utf8")) as unknown;
        this.book = Array.isArray(raw) ? raw.filter((entry): entry is RepoTransfer => typeof entry?.id === "string" && typeof entry?.root === "string") : [];
      } catch {
        this.book = [];
      }
      // A transfer the host stopped during cannot resume: its steps ran in this process.
      for (const transfer of this.book) {
        if (transfer.state === "sending") Object.assign(transfer, { state: "failed", error: "Tau stopped while this transfer was on its way." });
      }
    }
    return this.book;
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    const write = this.writing.catch(() => undefined).then(async () => {
      await mkdir(this.options.stateDir, { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    });
    this.writing = write;
    await write;
  }

  private async commit(transfer: RepoTransfer): Promise<RepoTransfer> {
    const book = await this.load();
    const index = book.findIndex((entry) => entry.id === transfer.id);
    if (index >= 0) book[index] = transfer;
    else book.unshift(transfer);
    // The oldest settled records go first; a book is a list to act on, not a log.
    while (book.length > MAX_BOOK) {
      const oldest = book.map((entry, at) => ({ entry, at })).reverse().find(({ entry }) => entry.state !== "sending");
      if (!oldest) break;
      book.splice(oldest.at, 1);
    }
    await this.writeJson(this.bookPath, book);
    const copy = structuredClone(transfer);
    this.options.emit(copy);
    return copy;
  }

  async list(filter: { root?: string } = {}): Promise<RepoTransfer[]> {
    const book = await this.load();
    return structuredClone(filter.root ? book.filter((entry) => entry.root === filter.root) : book);
  }

  async get(id: string): Promise<RepoTransfer> {
    const found = (await this.load()).find((entry) => entry.id === id);
    if (!found) throw new HostCommandError(`No transfer ${id} on this machine.`);
    return structuredClone(found);
  }

  /** The checkout's top folder for any folder inside it. */
  async rootOf(cwd: string): Promise<string> {
    const root = (await this.git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
    if (!root) throw new HostCommandError(`${cwd} is not inside a Git repository.`);
    return root;
  }

  private machines(): HostMachineServices {
    const machines = this.options.machines();
    if (!machines) throw new HostCommandError("This host keeps no other machines for its agents.");
    return machines;
  }

  private machine(name: string): HostMachine {
    const all = this.machines().list();
    const byId = all.find((machine) => machine.id === name);
    const byName = all.filter((machine) => machine.name === name);
    const machine = byId ?? (byName.length === 1 ? byName[0] : undefined);
    if (!machine) throw new HostCommandError(byName.length > 1 ? `More than one machine is called ${name}; name it by its id.` : `This computer's agents do not know a machine ${name}.`);
    if (machine.status !== "connected") throw new HostCommandError(`${machine.name} is ${machine.status}${machine.detail ? `: ${machine.detail}` : ""}.`);
    if (machine.readOnly) throw new HostCommandError(`${machine.name} lets this computer's agents in Read only; work there needs Full access.`);
    return machine;
  }

  private exclusive<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) return Promise.reject(new HostCommandError(`Transfer ${id} is busy; wait for it to finish.`));
    this.busy.add(id);
    return run().finally(() => this.busy.delete(id));
  }

  /**
   * Follows an operation on the other machine to its end: its topic for each
   * step as it happens, and a poll that also catches up after a reconnect.
   */
  private follow<Result>(machine: string, id: string, onSnapshot: (snapshot: OperationSnapshot) => void): Promise<Result> {
    const machines = this.machines();
    const pollMs = this.options.pollMs ?? 1000;
    const grace = this.options.offlineGraceMs ?? 120_000;
    return new Promise<Result>((resolve, reject) => {
      let settled = false;
      const handle = (snapshot: OperationSnapshot) => {
        if (settled || snapshot?.id !== id) return;
        onSnapshot(snapshot);
        if (snapshot.state === "running") return;
        settled = true;
        stop();
        if (snapshot.state === "done") resolve(snapshot.result as Result);
        else reject(new Error(snapshot.error ?? "The operation failed there."));
      };
      const stop = machines.watch(machine, operationTopic(id), (event) => {
        if (event.name === OPERATION_EVENT) handle(event.payload as OperationSnapshot);
      });
      void (async () => {
        let lastAnswer = this.now();
        while (!settled) {
          try {
            handle(await machines.call(machine, REMOTE_WORK_EXTENSION_ID, RECEIVING_COMMANDS.operation, { id }) as OperationSnapshot);
            lastAnswer = this.now();
          } catch (error) {
            const lost = /no operation/u.test(errorText(error)) || this.now() - lastAnswer > grace;
            if (lost && !settled) {
              settled = true;
              stop();
              reject(new Error(/no operation/u.test(errorText(error)) ? errorText(error) : `The other machine stopped answering: ${errorText(error)}`));
              return;
            }
          }
          if (!settled) await wait(pollMs);
        }
      })();
    });
  }

  private async start(machine: string, command: string, input: unknown): Promise<string> {
    const started = await this.machines().call(machine, REMOTE_WORK_EXTENSION_ID, command, input) as { operation?: unknown; protocol?: unknown };
    if (typeof started?.operation !== "string") throw new Error("The other machine's Remote Work Kit answered in a way this one does not read; update Tau there.");
    if (typeof started.protocol === "number" && started.protocol !== REMOTE_WORK_PROTOCOL) {
      throw new HostCommandError(`The other machine speaks Remote Work protocol ${started.protocol}, this one ${REMOTE_WORK_PROTOCOL}; update Tau on both to the same version.`);
    }
    return started.operation;
  }

  /**
   * Sends the state of the checkout at `input.cwd` to a machine and answers
   * once a worktree there holds it and its setup ran. Progress arrives as
   * `transfer` events; a failure leaves the record with the step that failed.
   */
  async send(input: SendRepoInput): Promise<RepoTransfer> {
    const machine = this.machine(input.machine);
    const identity = await readRepoIdentity(input.cwd, this.git);
    const ignored = input.ignored ?? (await this.selectionOf(identity)).paths;
    const transfer: RepoTransfer = {
      id: (this.options.newId ?? (() => randomUUID().replaceAll("-", "").slice(0, 16)))(),
      machine: machine.id,
      machineName: machine.name,
      root: identity.root,
      repo: { key: identity.key, name: identity.name, source: identity.source, ...(identity.origin ? { origin: identity.origin } : {}) },
      base: "",
      head: "",
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ignored,
      createdAt: this.now(),
      state: "sending",
      steps: TRANSFER_STEPS.map((step) => ({ ...step, state: "pending" })),
    };
    await this.commit(transfer);
    const set = async (id: TransferStepId, state: TransferStepState, detail?: string, fraction?: number) => {
      transfer.steps = transfer.steps.map((step): TransferStep => step.id !== id ? step : {
        id: step.id, label: step.label, state, ...(detail ? { detail } : {}), ...(fraction !== undefined ? { fraction } : {}),
      });
      await this.commit(transfer);
    };
    const merge = (snapshot: OperationSnapshot) => {
      transfer.steps = transfer.steps.map((step) => {
        const there = snapshot.steps.find((candidate) => candidate.id === step.id);
        return there ? { ...step, state: there.state, ...(there.detail ? { detail: there.detail } : {}) } : step;
      });
      void this.commit(transfer).catch(() => undefined);
    };
    const directory = await mkdtemp(join(this.options.tmpDir ?? tmpdir(), "tau-remote-work-"));
    return this.exclusive(transfer.id, async () => {
      try {
        await set("state", "running");
        const state = await captureTransferState({ root: identity.root, transfer: transfer.id, machineName: machine.name, snapshotRef: input.snapshotRef, git: this.git });
        transfer.base = state.base;
        transfer.head = state.head;
        await set("state", "done", state.dirty ? "HEAD and the uncommitted work" : "HEAD; nothing uncommitted");

        await set("check", "running");
        const readiness = await this.machines().request(machine.id, "readiness", [], { timeoutMs: 20_000 }).then((value) => value as HostReadiness, () => undefined);
        if (!readiness) await set("check", "skipped", `${machine.name} does not report its readiness`);
        else {
          if (!readiness.git?.version) throw new HostCommandError(`${machine.name} has no git on its host's PATH.`);
          const free = readiness.disk?.free;
          if (free !== undefined && free < MIN_FREE_BYTES) throw new HostCommandError(`${machine.name} has only ${size(free)} free.`);
          await set("check", "done", `git ${readiness.git.version}${free !== undefined ? `, ${size(free)} free` : ""}`);
        }

        await set("mirror", "running");
        const prepareId = await this.start(machine.id, RECEIVING_COMMANDS.prepare, { protocol: REMOTE_WORK_PROTOCOL, transfer: transfer.id, repo: transfer.repo });
        const prepared = await this.follow<PrepareResult>(machine.id, prepareId, merge);

        await set("bundle", "running");
        const bundle = await createTransferBundle({ root: identity.root, transfer: transfer.id, tips: prepared.tips, directory, git: this.git });
        let blob: { id: string; sha256: string } | undefined;
        if (!bundle) {
          await set("bundle", "skipped", `${machine.name} has every commit already`);
          await set("upload", "skipped");
        } else {
          await set("bundle", "done", `${bundle.commits} commit${bundle.commits === 1 ? "" : "s"}, ${size(bundle.size)}`);
          await set("upload", "running", undefined, 0);
          const uploaded = await this.machines().upload(machine.id, createReadStream(bundle.path), {
            size: bundle.size,
            onProgress: ({ sent }) => void set("upload", "running", `${size(sent)} of ${size(bundle.size)}`, bundle.size ? sent / bundle.size : 1).catch(() => undefined),
          });
          if (uploaded.sha256 !== bundle.sha256) throw new Error("The bundle arrived with another checksum.");
          blob = { id: uploaded.id, sha256: uploaded.sha256 };
          await set("upload", "done", size(bundle.size));
        }

        const files = await collectIgnoredFiles(identity.root, ignored, this.git);
        const receiveId = await this.start(machine.id, RECEIVING_COMMANDS.receive, {
          protocol: REMOTE_WORK_PROTOCOL, transfer: transfer.id, repo: transfer.repo, base: state.base, ...(blob ? { blob } : {}), files,
        });
        const received = await this.follow<ReceiveResult>(machine.id, receiveId, merge);
        transfer.remote = { path: received.worktree, branch: received.branch, ...(received.workspaceId ? { workspaceId: received.workspaceId } : {}) };
        transfer.state = "ready";
        await this.commit(transfer);
        this.options.log?.("remote-work.sent", `${transfer.id} ${identity.root} → ${machine.name}:${received.worktree}`);
        return structuredClone(transfer);
      } catch (error) {
        transfer.steps = transfer.steps.map((step) => (step.state === "running" ? { ...step, state: "failed" } : step));
        transfer.state = "failed";
        transfer.error = errorText(error);
        await this.commit(transfer);
        this.options.log?.("remote-work.send-failed", `${transfer.id}: ${transfer.error}`);
        throw error instanceof HostCommandError ? error : new HostCommandError(transfer.error);
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  /**
   * Brings back what was done there: the other machine commits what is open
   * and bundles it, this side pulls the bundle piece by piece and takes it into
   * `tau/<machine>/<slug>`. Asking again takes the newer state into the same branch.
   */
  async fetchResult(id: string): Promise<RepoTransfer> {
    let transfer = await this.get(id);
    if (transfer.state !== "ready" || !transfer.remote) throw new HostCommandError(`Transfer ${id} has no worktree there to bring back.`);
    const machine = this.machine(transfer.machine);
    return this.exclusive(id, async () => {
      const directory = await mkdtemp(join(this.options.tmpDir ?? tmpdir(), "tau-remote-result-"));
      try {
        const resultId = await this.start(machine.id, RECEIVING_COMMANDS.result, { protocol: REMOTE_WORK_PROTOCOL, transfer: id });
        const answer = await this.follow<ResultAnswer>(machine.id, resultId, () => undefined);
        if (answer.state === "nothing") {
          transfer.result = { state: "nothing", fetchedAt: this.now() };
          return await this.commit(transfer);
        }
        const path = join(directory, `${id}.bundle`);
        const hash = createHash("sha256");
        await writeFile(path, "");
        for (let offset = 0; offset < answer.size; offset += DOWNLOAD_PIECE_BYTES) {
          const length = Math.min(DOWNLOAD_PIECE_BYTES, answer.size - offset);
          const piece = await this.machines().call(machine.id, REMOTE_WORK_EXTENSION_ID, RECEIVING_COMMANDS.download, { transfer: id, offset, length }) as { data?: unknown };
          const bytes = Buffer.from(typeof piece?.data === "string" ? piece.data : "", "base64");
          if (bytes.length !== length) throw new Error(`A piece of the result came back with ${bytes.length} of ${length} bytes.`);
          hash.update(bytes);
          await appendFile(path, bytes);
        }
        if (hash.digest("hex") !== answer.sha256) throw new Error("The result bundle arrived with another checksum.");
        const branch = transfer.result?.state === "branch" ? transfer.result.branch : await resultBranchName({ root: transfer.root, machineName: transfer.machineName, name: transfer.name, transfer: id, git: this.git });
        const stored = await storeResultBundle({ root: transfer.root, transfer: id, bundle: path, branch, base: transfer.base, git: this.git });
        transfer = await this.get(id);
        transfer.result = { state: "branch", ...stored, fetchedAt: this.now() };
        delete transfer.applied;
        this.options.log?.("remote-work.result", `${id} → ${stored.branch} (${stored.commits} commits, ${stored.files} files)`);
        return await this.commit(transfer);
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  private resultBranch(transfer: RepoTransfer): string {
    if (transfer.result?.state !== "branch") throw new HostCommandError(`Transfer ${transfer.id} has no result branch here yet; bring the result back first.`);
    return transfer.result.branch;
  }

  /** Whether the result merges into the checkout cleanly, read with `git merge-tree` only. */
  async preview(id: string): Promise<TransferPreview> {
    const transfer = await this.get(id);
    const branch = this.resultBranch(transfer);
    const preview = await previewBranchMerge(transfer.root, branch, asAgentRunner(this.git));
    return { transfer: id, branch, clean: preview.conflicts.length === 0, merged: preview.merged, conflicts: preview.conflicts };
  }

  /**
   * Merges the result branch into the checkout it came from, only when clean
   * (`merge-tree`, then `merge --no-ff`). A conflict, or uncommitted work the
   * merge would overwrite, leaves the checkout exactly as it was and the
   * branch where it is, with the files named.
   */
  async apply(id: string): Promise<RepoTransfer> {
    return this.exclusive(id, async () => {
      let transfer = await this.get(id);
      const branch = this.resultBranch(transfer);
      const git = await withIdentity(this.git, transfer.root);
      const outcome = await mergeBranchIntoCheckout({ cwd: transfer.root, branch, base: transfer.base, runGit: asAgentRunner(git) });
      transfer = await this.get(id);
      transfer.applied = { state: outcome.state, at: this.now(), files: outcome.files, detail: outcome.detail, ...(outcome.commit ? { commit: outcome.commit } : {}) };
      this.options.log?.("remote-work.apply", `${id} ${branch}: ${outcome.state}`);
      return this.commit(transfer);
    });
  }

  /**
   * Lets a transfer go: its worktree and branch there, and this side's
   * transfer ref. The result branch here stays; it is the user's now.
   */
  async discard(id: string): Promise<RepoTransfer> {
    return this.exclusive(id, async () => {
      let transfer = await this.get(id);
      if (transfer.remote) {
        const machines = this.machines();
        await machines.call(transfer.machine, REMOTE_WORK_EXTENSION_ID, RECEIVING_COMMANDS.remove, { transfer: id });
      }
      await this.git(transfer.root, ["update-ref", "-d", transferRef(id)]).catch(() => "");
      transfer = await this.get(id);
      transfer.state = "discarded";
      delete transfer.remote;
      this.options.log?.("remote-work.discard", id);
      return this.commit(transfer);
    });
  }

  // -------------------------------------------------------------------------
  // Ignored files, remembered per project in this kit's own state

  private async loadSelections(): Promise<Record<string, { paths: string[]; updatedAt: number }>> {
    if (!this.selections) {
      try {
        const raw = JSON.parse(await readFile(this.selectionsPath, "utf8")) as unknown;
        this.selections = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, { paths: string[]; updatedAt: number }> : {};
      } catch {
        this.selections = {};
      }
    }
    return this.selections;
  }

  private async selectionOf(identity: CheckoutIdentity): Promise<{ paths: string[] }> {
    const entry = (await this.loadSelections())[identity.key];
    return { paths: Array.isArray(entry?.paths) ? entry.paths.filter((path) => typeof path === "string" && safeRelativePath(path)) : [] };
  }

  /** What Tau offers to send along for the checkout at `cwd`, and what the user ticked for its project. */
  async ignoredFiles(cwd: string): Promise<IgnoredFilesView> {
    const identity = await readRepoIdentity(cwd, this.git);
    const { candidates, skipped } = await suggestIgnoredFiles(identity.root, this.git);
    const offered = new Set(candidates.map((candidate) => candidate.path));
    const selected = (await this.selectionOf(identity)).paths.filter((path) => offered.has(path));
    return { root: identity.root, key: identity.key, candidates, selected, skipped };
  }

  /** Remembers the user's choice for the project (by its identity, so every checkout of it shares it). */
  async setIgnoredFiles(cwd: string, paths: readonly string[]): Promise<IgnoredFilesView> {
    const identity = await readRepoIdentity(cwd, this.git);
    const clean = [...new Set(paths.map((path) => (typeof path === "string" && safeRelativePath(path) ? path : undefined)).filter((path): path is string => Boolean(path)))].sort();
    const selections = await this.loadSelections();
    if (clean.length === 0) delete selections[identity.key];
    else selections[identity.key] = { paths: clean, updatedAt: this.now() };
    await this.writeJson(this.selectionsPath, selections);
    return this.ignoredFiles(cwd);
  }
}
