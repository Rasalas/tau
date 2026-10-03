import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError, transferPromptAttachments, type HostMachine, type HostMachineServices, type HostMachineStatus } from "tau/host-extension";
import {
  BUSY_REMOTE_STATUSES,
  DEFAULT_REMOTE_WAIT_MS,
  HOSTED_COMMANDS,
  HOSTED_THREAD_EVENT,
  MAX_REMOTE_WAIT_MS,
  REMOTE_WORK_EXTENSION_ID,
  REMOTE_WORK_PROTOCOL,
  hostedThreadTopic,
  type HostedHello,
  type HostedThreadReport,
  type HostedThreadStartInput,
  type RemoteThreadDelivery,
  type RemoteThreadLink,
  type RemoteThreadStartInput,
  type RemoteThreadWaitReason,
  type RemoteThreadWaitResult,
} from "./protocol.js";
import type { RepoTransfers } from "./transfers.js";

const MAX_BOOK = 200;
const MAX_PROMPT = 64_000;
/** How long `settle(discard)` gives an aborted turn to end before the worktree there goes. */
const ABORT_SETTLE_MS = 15_000;

/** What the thread service needs of the transfers: the same kit's `RepoTransfers`. */
export type ThreadTransfers = Pick<RepoTransfers, "send" | "fetchResult" | "apply" | "discard" | "rootOf">;

export interface RemoteThreadsOptions {
  machines(): HostMachineServices | undefined;
  transfers: ThreadTransfers;
  /** A Pi thread's session file here, for `start({ session })`. */
  readSession(threadId: string): Promise<string>;
  stateDir: string;
  emit(link: RemoteThreadLink): void;
  log?(label: string, detail?: string): void;
  now?(): number;
  newId?(): string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const unreachable = (status: HostMachineStatus | undefined) => status === "offline" || status === "refused";
const clone = <T>(value: T): T => structuredClone(value);

function titleOf(input: RemoteThreadStartInput): string {
  if (input.title?.trim()) return input.title.trim();
  const words = (input.prompt ?? "").trim().split(/\s+/u).slice(0, 6).join(" ");
  return words || "Thread";
}

/**
 * Threads started from here on another machine (plan-H §5, `tau.remote-work/threads`).
 * The thread there is an ordinary thread in a worktree that holds this
 * checkout's state; here there is only a link: the machine, the thread's id
 * there, the transfer and its base. The status comes from there, as a topic
 * this side watches and asks for again after a reconnect; the machine there
 * never reaches back. `<stateDir>/remote-links.json` keeps the links.
 */
export class RemoteThreads {
  private readonly links = new Map<string, RemoteThreadLink>();
  private readonly watching = new Map<string, () => void>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly machineStatus = new Map<string, HostMachineStatus>();
  private readonly aborted = new Set<string>();
  private writing: Promise<unknown> = Promise.resolve();
  private stopMachines?: () => void;
  private closed = false;

  constructor(private readonly options: RemoteThreadsOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get bookPath(): string {
    return join(this.options.stateDir, "remote-links.json");
  }

  /** Reads the book, follows every link that still has a thread there, and watches the machines. */
  async open(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.bookPath, "utf8"));
    } catch {
      raw = [];
    }
    for (const link of Array.isArray(raw) ? raw as RemoteThreadLink[] : []) {
      if (typeof link?.id !== "string" || typeof link.machine !== "string") continue;
      // Its start ran in this process; with no thread there yet it cannot resume.
      if (!link.thread && (link.status === "sending" || link.status === "starting")) {
        Object.assign(link, { status: "failed", error: `Tau stopped here while this thread was on its way to ${link.machineName}.` });
      }
      this.links.set(link.id, link);
    }
    const machines = this.options.machines();
    if (!machines) return;
    for (const link of this.links.values()) if (this.follows(link)) this.watch(link);
    this.stopMachines = machines.subscribe((list) => this.onMachines(list));
    this.onMachines(machines.list());
  }

  close(): void {
    this.closed = true;
    this.stopMachines?.();
    for (const stop of this.watching.values()) stop();
    this.watching.clear();
    for (const waiters of this.waiters.values()) for (const wake of waiters) wake();
  }

  /** Settles the book's last write. */
  async flush(): Promise<void> {
    await this.writing.catch(() => undefined);
  }

  private save(): Promise<void> {
    const entries = [...this.links.values()].sort((left, right) => right.createdAt - left.createdAt);
    // The oldest links that are over go first; a book is a list to act on.
    while (entries.length > MAX_BOOK) {
      const at = entries.map((link, index) => ({ link, index })).reverse().find(({ link }) => !this.follows(link) && !BUSY_REMOTE_STATUSES.includes(link.status));
      if (!at) break;
      entries.splice(at.index, 1);
      this.links.delete(at.link.id);
    }
    const write = this.writing.catch(() => undefined).then(async () => {
      await mkdir(this.options.stateDir, { recursive: true });
      const temporary = `${this.bookPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(entries, null, 1)}\n`, { mode: 0o600 });
      await rename(temporary, this.bookPath);
    });
    this.writing = write;
    return write;
  }

  private async commit(link: RemoteThreadLink): Promise<RemoteThreadLink> {
    link.updatedAt = this.now();
    this.links.set(link.id, link);
    // Published at the change, not after the write: a slow disk must not merge or reorder events.
    const copy = clone(link);
    this.options.emit(copy);
    for (const wake of this.waiters.get(link.id) ?? []) wake();
    await this.save();
    return copy;
  }

  list(filter: { machine?: string; parentThreadId?: string; active?: boolean } = {}): RemoteThreadLink[] {
    return clone([...this.links.values()]
      .filter((link) => !filter.machine || link.machine === filter.machine || link.machineName === filter.machine)
      .filter((link) => !filter.parentThreadId || link.parentThreadId === filter.parentThreadId)
      .filter((link) => !filter.active || (link.status !== "settled" && link.status !== "gone"))
      .sort((left, right) => right.createdAt - left.createdAt));
  }

  private link(id: string): RemoteThreadLink {
    const link = this.links.get(id);
    if (!link) throw new HostCommandError(`No thread link ${id} on this machine.`);
    return link;
  }

  get(id: string): RemoteThreadLink {
    return clone(this.link(id));
  }

  // ---------------------------------------------------------------------------
  // The machines

  private machines(): HostMachineServices {
    const machines = this.options.machines();
    if (!machines) throw new HostCommandError("This host keeps no other machines for its agents.");
    return machines;
  }

  private machine(name: string): HostMachine {
    const all = this.machines().list();
    const byName = all.filter((machine) => machine.name.toLowerCase() === name.trim().toLowerCase());
    const machine = all.find((candidate) => candidate.id === name) ?? (byName.length === 1 ? byName[0] : undefined);
    if (!machine) throw new HostCommandError(byName.length > 1 ? `More than one machine is called ${name}; name it by its id.` : `This computer's agents do not know a machine ${name}.`);
    if (machine.status !== "connected") throw new HostCommandError(`${machine.name} is ${machine.status}${machine.detail ? `: ${machine.detail}` : ""}.`);
    if (machine.readOnly) throw new HostCommandError(`${machine.name} lets this computer's agents in Read only; a thread there needs Full access.`);
    return machine;
  }

  /** Refuses a machine whose Remote Work speaks another protocol, with both versions named. */
  private async hello(machine: HostMachine, attachments = false): Promise<void> {
    const machines = this.machines();
    const theirs = `${machine.name} has Tau ${machine.hostVersion ?? "of an unknown version"}`;
    let answer: HostedHello;
    try {
      answer = await machines.call(machine.id, REMOTE_WORK_EXTENSION_ID, HOSTED_COMMANDS.hello, { protocol: REMOTE_WORK_PROTOCOL }) as HostedHello;
    } catch (error) {
      const text = errorText(error);
      if (/has no command|is not installed/u.test(text)) throw new HostCommandError(`${theirs}, needs ≥ ${machines.self.version} to run a thread started here; update Tau there.`);
      if (/is not active/u.test(text)) throw new HostCommandError(`${machine.name} has Remote Work turned off; turn it on there to run a thread started here.`);
      throw error;
    }
    const protocol = typeof answer?.protocol === "number" ? answer.protocol : 0;
    if (protocol < REMOTE_WORK_PROTOCOL) throw new HostCommandError(`${theirs}, needs ≥ ${machines.self.version} to run a thread started here; update Tau there.`);
    if (protocol > REMOTE_WORK_PROTOCOL) throw new HostCommandError(`${theirs}, newer than this machine's ${machines.self.version}; update Tau here.`);
    if (attachments && answer.attachments !== true) throw new HostCommandError(`${machine.name} cannot receive attachments yet; update Tau there.`);
  }

  private onMachines(list: readonly HostMachine[]): void {
    if (this.closed) return;
    for (const machine of list) {
      const before = this.machineStatus.get(machine.id);
      this.machineStatus.set(machine.id, machine.status);
      if (unreachable(machine.status)) {
        for (const link of this.links.values()) {
          if (link.machine !== machine.id || !this.follows(link) || link.status === "offline") continue;
          link.status = "offline";
          void this.commit(link).catch(() => undefined);
        }
      } else if (machine.status === "connected" && before !== "connected") {
        void this.refresh(machine.id);
      }
    }
  }

  /** A link whose thread exists there and is not over: its topic is watched and its status asked for. */
  private follows(link: RemoteThreadLink): boolean {
    return Boolean(link.thread) && link.status !== "settled" && link.status !== "gone";
  }

  private watch(link: RemoteThreadLink): void {
    if (!link.thread || this.watching.has(link.id)) return;
    const machines = this.options.machines();
    if (!machines) return;
    try {
      this.watching.set(link.id, machines.watch(link.machine, hostedThreadTopic(link.thread), (event) => {
        if (event.name === HOSTED_THREAD_EVENT) void this.apply(link.id, event.payload as HostedThreadReport);
      }));
    } catch (error) {
      this.options.log?.("remote-work.thread-watch-failed", `${link.id}: ${errorText(error)}`);
    }
  }

  private unwatch(id: string): void {
    this.watching.get(id)?.();
    this.watching.delete(id);
  }

  /** Asks the machine once for every link it runs a thread of; after a reconnect nothing that happened meanwhile arrived. */
  private async refresh(machine: string, only?: readonly string[]): Promise<void> {
    const links = [...this.links.values()].filter((link) => link.machine === machine && this.follows(link) && (!only || only.includes(link.id)));
    if (links.length === 0) return;
    try {
      const answer = await this.machines().call(machine, REMOTE_WORK_EXTENSION_ID, HOSTED_COMMANDS.reports, {
        protocol: REMOTE_WORK_PROTOCOL, threads: links.map((link) => link.thread),
      }) as { reports?: HostedThreadReport[] };
      for (const report of answer?.reports ?? []) {
        const link = links.find((candidate) => candidate.thread === report.thread);
        if (link) await this.apply(link.id, report);
      }
    } catch (error) {
      this.options.log?.("remote-work.thread-refresh-failed", `${machine}: ${errorText(error)}`);
    }
  }

  private async apply(id: string, report: HostedThreadReport): Promise<void> {
    const link = this.links.get(id);
    if (!link || !report || report.thread !== link.thread) return;
    // An answer asked for before a push can arrive after it; the revision says which is newer.
    if (link.there && report.epoch === link.there.epoch && report.revision < link.there.revision) return;
    link.there = report;
    link.seenAt = this.now();
    if (report.usage) link.usage = report.usage;
    if (report.state === "failed") link.error = report.error ?? `The last turn failed on ${link.machineName}.`;
    else delete link.error;
    if (link.status !== "settled") {
      link.status = unreachable(this.machineStatus.get(link.machine)) ? "offline" : report.state;
      if (report.state === "gone") this.unwatch(id);
    }
    await this.commit(link).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // The service

  /**
   * Starts a thread on another machine and answers its link at once: the
   * checkout's state travels there (`RepoTransfers.send`), then the thread
   * starts in that worktree, and the link follows it. A failure on the way
   * leaves the link `failed` with the reason.
   */
  async start(input: RemoteThreadStartInput): Promise<RemoteThreadLink> {
    const prompt = input.prompt?.trim();
    if (!prompt && !input.session && !input.attachments?.length) throw new HostCommandError("A thread needs a prompt or a session to start from.");
    if (prompt && prompt.length > MAX_PROMPT) throw new HostCommandError(`A prompt has at most ${MAX_PROMPT} characters.`);
    const machine = this.machine(input.machine);
    await this.hello(machine, Boolean(input.attachments?.length));
    const jsonl = input.session ? await this.options.readSession(input.session.threadId) : undefined;
    const root = await this.options.transfers.rootOf(input.cwd);
    const link: RemoteThreadLink = {
      id: (this.options.newId ?? (() => randomUUID().replaceAll("-", "").slice(0, 16)))(),
      machine: machine.id,
      machineName: machine.name,
      cwd: input.cwd,
      root,
      title: titleOf(input),
      ...(input.parentThreadId ? { parentThreadId: input.parentThreadId } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      ...(input.backend ? { backend: input.backend } : {}),
      ...(input.model ? { model: input.model } : {}),
      status: "sending",
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    const answer = await this.commit(link);
    void this.launch(link, input, prompt, jsonl);
    return answer;
  }

  private async launch(link: RemoteThreadLink, input: RemoteThreadStartInput, prompt: string | undefined, jsonl: string | undefined): Promise<void> {
    try {
      const transfer = await this.options.transfers.send({
        machine: link.machine,
        cwd: input.cwd,
        name: link.title,
        ...(input.ignored ? { ignored: input.ignored } : {}),
      });
      Object.assign(link, { transfer: transfer.id, base: transfer.base, status: "starting" }, transfer.remote ? { worktree: transfer.remote.path, worktreeBranch: transfer.remote.branch } : {});
      if (this.aborted.delete(link.id)) throw new Error(`Stopped before the thread started on ${link.machineName}.`);
      await this.commit(link);
      const machines = this.machines();
      const start: HostedThreadStartInput = {
        protocol: REMOTE_WORK_PROTOCOL,
        transfer: transfer.id,
        ...(prompt ? { prompt } : {}),
        ...(jsonl && input.session ? { session: { jsonl, origin: { hostId: machines.self.id, threadId: input.session.threadId } } } : {}),
        ...(link.title ? { title: link.title } : {}),
        ...(link.backend ? { backend: link.backend } : {}),
        ...(link.model ? { model: link.model } : {}),
        ...(input.agentDepth ? { agentDepth: input.agentDepth } : {}),
        ...(input.attachments?.length ? { attachments: await transferPromptAttachments(machines, link.machine, input.attachments) } : {}),
        ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      };
      const report = await machines.call(link.machine, REMOTE_WORK_EXTENSION_ID, HOSTED_COMMANDS.start, start) as HostedThreadReport;
      if (typeof report?.thread !== "string") throw new Error(`${link.machineName} answered the start in a way this Tau does not read; update Tau there.`);
      link.thread = report.thread;
      this.watch(link);
      await this.apply(link.id, report);
      // What happened between its answer and the watch arrives by asking once.
      await this.refresh(link.machine, [link.id]);
      this.options.log?.("remote-work.thread-started", `${link.id} → ${link.machineName}:${link.thread.slice(0, 8)}`);
    } catch (error) {
      this.aborted.delete(link.id);
      link.status = "failed";
      link.error = errorText(error);
      await this.commit(link).catch(() => undefined);
      this.options.log?.("remote-work.thread-start-failed", `${link.id}: ${link.error}`);
    }
  }

  private live(id: string): RemoteThreadLink & { thread: string } {
    const link = this.link(id);
    if (link.status === "settled") throw new HostCommandError(`That thread on ${link.machineName} is settled; start a new one.`);
    if (link.status === "gone") throw new HostCommandError(`That thread was deleted on ${link.machineName}.`);
    if (!link.thread) throw new HostCommandError(link.status === "failed" ? `That thread never started on ${link.machineName}: ${link.error ?? "unknown reason"}` : `That thread is still on its way to ${link.machineName}.`);
    return link as RemoteThreadLink & { thread: string };
  }

  /** Sends a message as the composer there would: `prompt` starts or joins a turn, `steer` joins now, `queue` waits. */
  async send(id: string, text: string, delivery: RemoteThreadDelivery = "prompt"): Promise<RemoteThreadLink> {
    const message = text.trim();
    if (!message) throw new HostCommandError("The message is empty.");
    if (message.length > MAX_PROMPT) throw new HostCommandError(`A message has at most ${MAX_PROMPT} characters.`);
    const link = this.live(id);
    const report = await this.machines().call(link.machine, REMOTE_WORK_EXTENSION_ID, HOSTED_COMMANDS.send, {
      protocol: REMOTE_WORK_PROTOCOL, thread: link.thread, text: message, delivery,
    }) as HostedThreadReport;
    await this.apply(id, report);
    return this.get(id);
  }

  /** Stops the running turn there; a thread still on its way does not start. */
  async abort(id: string): Promise<RemoteThreadLink> {
    const link = this.link(id);
    if (!link.thread && (link.status === "sending" || link.status === "starting")) {
      this.aborted.add(id);
      return this.get(id);
    }
    const live = this.live(id);
    const report = await this.machines().call(live.machine, REMOTE_WORK_EXTENSION_ID, HOSTED_COMMANDS.abort, {
      protocol: REMOTE_WORK_PROTOCOL, thread: live.thread,
    }) as HostedThreadReport;
    await this.apply(id, report);
    return this.get(id);
  }

  private reasonOf(link: RemoteThreadLink): RemoteThreadWaitReason | undefined {
    if (link.status === "offline") return "offline";
    if (BUSY_REMOTE_STATUSES.includes(link.status)) return undefined;
    return link.status as RemoteThreadWaitReason;
  }

  /**
   * Waits until the thread is no longer busy there. An unreachable machine
   * answers `offline` at once: the thread may still run there, and waiting
   * again after it is back reads what it did meanwhile.
   */
  wait(id: string, timeoutMs = DEFAULT_REMOTE_WAIT_MS): Promise<RemoteThreadWaitResult> {
    this.link(id);
    const bound = Math.min(Math.max(1, Math.round(timeoutMs)), MAX_REMOTE_WAIT_MS);
    return new Promise((resolve) => {
      const waiters = this.waiters.get(id) ?? new Set<() => void>();
      this.waiters.set(id, waiters);
      let timer: NodeJS.Timeout | undefined;
      const done = (reason: RemoteThreadWaitReason) => {
        waiters.delete(check);
        if (waiters.size === 0) this.waiters.delete(id);
        if (timer) clearTimeout(timer);
        resolve({ reason, link: this.get(id) });
      };
      const check = () => {
        const link = this.links.get(id);
        const reason = link ? this.reasonOf(link) : "gone";
        if (reason) done(reason);
        else if (this.closed) done("timeout");
      };
      waiters.add(check);
      check();
      if (waiters.has(check)) {
        timer = setTimeout(() => done("timeout"), bound);
        timer.unref?.();
      }
    });
  }

  private assertQuiet(link: RemoteThreadLink, what: string): void {
    if (BUSY_REMOTE_STATUSES.includes(link.status)) throw new HostCommandError(`The thread on ${link.machineName} is still ${link.status === "sending" ? "on its way" : "working"}; wait for it or stop it before you ${what}.`);
  }

  /** Brings what the thread did back as `tau/<machine>/<slug>`, the worktree there committed as it stands. */
  async fetchResult(id: string): Promise<RemoteThreadLink> {
    const link = this.link(id);
    if (!link.transfer) throw new HostCommandError(`Nothing reached ${link.machineName} for that thread, so nothing comes back.`);
    if (link.status === "settled") throw new HostCommandError(`That thread on ${link.machineName} is settled already.`);
    this.assertQuiet(link, "bring its work back");
    const transfer = await this.options.transfers.fetchResult(link.transfer);
    if (transfer.result) link.result = transfer.result;
    delete link.applied;
    return this.commit(link);
  }

  /**
   * `apply`: brings the result back if it is not here yet and merges it when
   * that is clean; then the worktree and branch there go. A conflict or work
   * in the way leaves everything as it was and says so in `applied`.
   * `discard`: stops a running turn and lets the worktree there go at once.
   * The thread there stays, an ordinary thread of that machine, unless
   * `removeThread` moves it into that machine's trash as well.
   */
  async settle(id: string, how: "apply" | "discard", options: { removeThread?: boolean } = {}): Promise<RemoteThreadLink> {
    let link = this.link(id);
    if (link.status === "settled") return this.get(id);
    if (how === "apply") {
      this.assertQuiet(link, "apply its work");
      if (!link.transfer) throw new HostCommandError(`Nothing reached ${link.machineName} for that thread, so there is nothing to apply.`);
      if (link.result?.state !== "branch") await this.fetchResult(id);
      link = this.link(id);
      if (link.result?.state === "branch") {
        const applied = await this.options.transfers.apply(link.transfer!);
        if (applied.applied) link.applied = applied.applied;
        const state = applied.applied?.state;
        if (state !== "merged" && state !== "already-merged") return this.commit(link);
      }
      await this.options.transfers.discard(link.transfer!);
      const detail = link.result?.state === "branch"
        ? link.applied?.detail ?? `Merged ${link.result.branch}.`
        : `Nothing changed on ${link.machineName}.`;
      Object.assign(link, { status: "settled", settled: { how: "applied", at: this.now(), detail: `${detail} The worktree on ${link.machineName} is removed.` } });
    } else {
      if (link.thread && (link.status === "running" || link.status === "starting")) {
        await this.abort(id).catch(() => undefined);
        await this.wait(id, ABORT_SETTLE_MS);
        link = this.link(id);
      } else if (!link.thread && BUSY_REMOTE_STATUSES.includes(link.status)) {
        this.aborted.add(id);
        throw new HostCommandError(`The thread is still on its way to ${link.machineName}; it will not start there. Let it go once it says so.`);
      }
      if (link.transfer) await this.options.transfers.discard(link.transfer);
      Object.assign(link, { status: "settled", settled: { how: "discarded", at: this.now(), detail: link.transfer ? `Let go; the worktree on ${link.machineName} is removed.` : "Let go." } });
    }
    this.unwatch(id);
    if (options.removeThread && link.thread) await this.removeThere(link);
    this.options.log?.("remote-work.thread-settled", `${id} ${how}`);
    return this.commit(link);
  }

  /** Best effort: a thread that stays there is clutter on that machine, not lost work here. */
  private async removeThere(link: RemoteThreadLink): Promise<void> {
    try {
      await this.machines().call(link.machine, REMOTE_WORK_EXTENSION_ID, HOSTED_COMMANDS.remove, { protocol: REMOTE_WORK_PROTOCOL, thread: link.thread });
      if (link.settled) link.settled.detail = `${link.settled.detail} Its thread there is in ${link.machineName}'s trash.`;
    } catch (error) {
      this.options.log?.("remote-work.thread-remove-failed", `${link.id}: ${errorText(error)}`);
      if (link.settled) link.settled.detail = `${link.settled.detail} Its thread stays on ${link.machineName}: ${errorText(error)}`;
    }
  }
}
