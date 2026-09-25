import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError, type HostExtensionServices, type HostThread, type UiThreadUsage } from "tau/host-extension";
import type {
  HostedThreadReport,
  HostedThreadStartInput,
  HostedThreadState,
  HostedTurnOutcome,
  RemoteThreadDelivery,
  RemoteThreadModel,
} from "./protocol.js";

/** The last answer travels shortened; the transcript stays there. */
const LAST_MESSAGE_CHARS = 2_000;
const MAX_BOOK = 500;
/** Turn events of a thread not booked yet: `sessions.start` delivers the prompt before it answers. */
const MAX_EARLY = 100;

/** A thread this machine runs for another machine (`<stateDir>/hosted-threads.json`). */
interface HostedThread {
  thread: string;
  transfer: string;
  /** The paired device that started it; only it (or this machine's owner) reads and steers it. */
  device?: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
  turns: number;
  /** Turns accepted and not ended yet; above 0 after a restart means one was cut short. */
  open: number;
  /** Its first prompt is on its way and no turn was accepted yet. */
  starting?: boolean;
  outcome?: HostedTurnOutcome;
  error?: string;
  question?: string;
  lastMessage?: string;
  usage?: UiThreadUsage;
  model?: RemoteThreadModel;
  title?: string;
  /** An abort was asked; the turn that ends next ended because of it. */
  aborting?: boolean;
  gone?: boolean;
  /** Its depth in a tree of sub-agents on the machine that started it. */
  agentDepth?: number;
}

type EarlyEvent = { kind: "accepted" } | { kind: "ended"; outcome: "completed" | "failed" };

export interface HostedThreadsOptions {
  services: Pick<HostExtensionServices, "thread" | "sessions" | "log">;
  stateDir: string;
  emit(report: HostedThreadReport): void;
  now?(): number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The receiving side of a thread started from another machine (plan-H §5):
 * an ordinary thread here in the transfer's worktree, and a small book of
 * what the sending side needs to follow it — its state, derived from the
 * runtime and the turn events, its cost and its last answer. Every change is
 * emitted under the thread's topic; this machine never reaches back.
 */
export class HostedThreads {
  private readonly threads = new Map<string, HostedThread>();
  private readonly early = new Map<string, EarlyEvent[]>();
  /** This run of the host; revisions count within it. */
  private readonly epoch = randomUUID().slice(0, 8);
  private writing: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: HostedThreadsOptions) {}

  private get bookPath(): string {
    return join(this.options.stateDir, "hosted-threads.json");
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.bookPath, "utf8"));
    } catch {
      raw = [];
    }
    for (const entry of Array.isArray(raw) ? raw as HostedThread[] : []) {
      if (typeof entry?.thread !== "string" || typeof entry.transfer !== "string") continue;
      // A turn that was open when this host stopped did not end on its own.
      if (entry.open > 0) Object.assign(entry, { open: 0, outcome: "interrupted", error: "Tau stopped on this machine during the turn.", starting: false, aborting: false });
      this.threads.set(entry.thread, { ...entry, open: entry.open ?? 0, turns: entry.turns ?? 0, revision: 0 });
    }
  }

  /** Settles the book's last write. */
  async flush(): Promise<void> {
    await this.writing.catch(() => undefined);
  }

  private save(): Promise<void> {
    const entries = [...this.threads.values()].sort((left, right) => right.createdAt - left.createdAt).slice(0, MAX_BOOK);
    const write = this.writing.catch(() => undefined).then(async () => {
      await mkdir(this.options.stateDir, { recursive: true });
      const temporary = `${this.bookPath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(entries, null, 1)}\n`, { mode: 0o600 });
      await rename(temporary, this.bookPath);
    });
    this.writing = write;
    return write;
  }

  has(thread: string): boolean {
    return this.threads.has(thread);
  }

  private entry(thread: string, device: string | undefined): HostedThread {
    const found = this.threads.get(thread);
    if (!found || (found.device && device && found.device !== device)) throw new HostCommandError(`This machine runs no thread ${thread} for the caller.`);
    return found;
  }

  private live(thread: string): HostThread | undefined {
    try {
      return this.options.services.thread(thread);
    } catch {
      return undefined;
    }
  }

  private derive(entry: HostedThread): HostedThreadReport {
    const live = this.live(entry.thread);
    const streaming = live?.isStreaming() ?? false;
    let state: HostedThreadState;
    if (entry.gone) state = "gone";
    else if (entry.question) state = "waiting";
    else if (streaming || entry.open > 0) state = "running";
    else if (entry.starting) state = "starting";
    // Not streaming and not idle: the runtime holds something open for the user.
    else if (live && !live.isIdle()) state = "waiting";
    else if (entry.outcome === "failed" || entry.outcome === "interrupted") state = "failed";
    else state = "idle";
    const usage = live?.usage ?? entry.usage;
    const model = live?.model ?? entry.model;
    return {
      thread: entry.thread,
      state,
      turns: entry.turns,
      ...(entry.outcome ? { outcome: entry.outcome } : {}),
      ...(entry.error && state === "failed" ? { error: entry.error } : {}),
      ...(entry.question ? { question: entry.question } : {}),
      ...(entry.lastMessage ? { lastMessage: entry.lastMessage } : {}),
      ...(usage ? { usage } : {}),
      ...(model ? { model } : {}),
      ...(entry.title ? { title: entry.title } : {}),
      updatedAt: entry.updatedAt,
      epoch: this.epoch,
      revision: entry.revision,
    };
  }

  private changed(entry: HostedThread, persist = true): HostedThreadReport {
    entry.updatedAt = this.now();
    entry.revision += 1;
    const report = this.derive(entry);
    this.options.emit(report);
    if (persist) void this.save().catch((error: unknown) => this.options.services.log("remote-work.hosted-book-failed", errorText(error)));
    return report;
  }

  report(thread: string, device: string | undefined): HostedThreadReport {
    return this.derive(this.entry(thread, device));
  }

  /** Reports for the threads asked; one this machine does not run for the caller reads `gone`. */
  reports(threads: readonly string[], device: string | undefined): HostedThreadReport[] {
    return threads.map((thread) => {
      try {
        return this.report(thread, device);
      } catch {
        return { thread, state: "gone", turns: 0, updatedAt: this.now(), epoch: this.epoch, revision: Number.MAX_SAFE_INTEGER };
      }
    });
  }

  /**
   * Starts the thread in the transfer's worktree: a new thread with the
   * prompt, or the sending side's Pi session taken over and, with a prompt,
   * continued. It answers once the thread exists, not when it has answered.
   */
  async start(input: HostedThreadStartInput, worktree: string, device: string | undefined): Promise<HostedThreadReport> {
    const { sessions } = this.options.services;
    let thread: string;
    if (input.session) {
      if (!sessions.import) throw new HostCommandError("This machine's Tau cannot take a session from another machine; update it here.");
      const imported = await sessions.import({
        cwd: worktree,
        jsonl: input.session.jsonl,
        ...(input.title ? { title: input.title } : {}),
        origin: { ...input.session.origin, details: { transfer: input.transfer } },
      });
      thread = imported.sessionId;
    } else {
      if (!input.prompt) throw new HostCommandError("A thread needs a prompt or a session to start from.");
      const started = await sessions.start({
        cwd: worktree,
        prompt: input.prompt,
        ...(input.title ? { title: input.title } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.backend ? { backend: input.backend } : {}),
      });
      thread = started.sessionId;
    }
    const entry: HostedThread = {
      thread,
      transfer: input.transfer,
      ...(device ? { device } : {}),
      createdAt: this.now(),
      updatedAt: this.now(),
      revision: 0,
      turns: 0,
      open: 0,
      ...(input.title ? { title: input.title } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.prompt && !input.session ? { starting: true } : {}),
      ...(input.agentDepth ? { agentDepth: input.agentDepth } : {}),
    };
    this.threads.set(thread, entry);
    for (const event of this.early.get(thread) ?? []) {
      if (event.kind === "accepted") this.noteAccepted(entry);
      else await this.noteEnded(entry, event.outcome);
    }
    this.early.delete(thread);
    if (input.session && input.prompt) await this.send(thread, input.prompt, "prompt", device);
    this.options.services.log("remote-work.thread-started", `${thread.slice(0, 8)} in ${worktree}`);
    return this.changed(entry);
  }

  async send(thread: string, text: string, delivery: RemoteThreadDelivery, device: string | undefined): Promise<HostedThreadReport> {
    const entry = this.entry(thread, device);
    const send = this.options.services.sessions.send;
    if (!send) throw new HostCommandError("This machine's Tau cannot send to a thread; update it here.");
    if (entry.gone) throw new HostCommandError("That thread was deleted on this machine.");
    await send(thread, text, { delivery });
    entry.aborting = false;
    return this.changed(entry);
  }

  async abort(thread: string, device: string | undefined): Promise<HostedThreadReport> {
    const entry = this.entry(thread, device);
    const abort = this.options.services.sessions.abort;
    if (!abort) throw new HostCommandError("This machine's Tau cannot stop a thread; update it here.");
    const busy = entry.open > 0 || entry.starting || this.live(thread)?.isStreaming();
    if (busy) entry.aborting = true;
    await abort(thread);
    return this.changed(entry);
  }

  /**
   * Moves the thread into this machine's trash once the machine that started
   * it is done with it, so this machine's rail keeps only its own threads.
   */
  async remove(thread: string, device: string | undefined): Promise<HostedThreadReport> {
    const entry = this.entry(thread, device);
    if (!entry.gone) {
      const remove = this.options.services.sessions.remove;
      if (!remove) throw new HostCommandError("This machine's Tau cannot remove a thread; update it here.");
      await remove(thread);
      entry.gone = true;
      entry.open = 0;
    }
    return this.changed(entry);
  }

  /** A thread's depth among sub-agents, when another machine started it as one. */
  agentDepth(thread: string): number | undefined {
    return this.threads.get(thread)?.agentDepth;
  }

  // ---------------------------------------------------------------------------
  // What the host reports about its threads

  private hold(thread: string, event: EarlyEvent): void {
    const events = this.early.get(thread) ?? [];
    events.push(event);
    this.early.set(thread, events);
    if (this.early.size > MAX_EARLY) this.early.delete(this.early.keys().next().value!);
  }

  private noteAccepted(entry: HostedThread): void {
    entry.open += 1;
    entry.starting = false;
    delete entry.question;
  }

  private async noteEnded(entry: HostedThread, outcome: "completed" | "failed"): Promise<void> {
    entry.open = Math.max(0, entry.open - 1);
    entry.turns += 1;
    entry.starting = false;
    delete entry.error;
    const live = this.live(entry.thread);
    const last = live ? [...await live.transcript().catch(() => [])].reverse().find((message) => message.role === "assistant") : undefined;
    if (last?.text) entry.lastMessage = last.text.length > LAST_MESSAGE_CHARS ? `${last.text.slice(0, LAST_MESSAGE_CHARS)}…` : last.text;
    if (entry.aborting) entry.outcome = "aborted";
    else if (outcome === "failed" || last?.error) {
      entry.outcome = "failed";
      if (last?.error) entry.error = last.error;
    } else entry.outcome = "completed";
    if (entry.open === 0) entry.aborting = false;
    if (live?.usage) entry.usage = live.usage;
    if (live?.model) entry.model = live.model;
  }

  accepted(thread: string): void {
    const entry = this.threads.get(thread);
    if (!entry) return this.hold(thread, { kind: "accepted" });
    this.noteAccepted(entry);
    this.changed(entry, false);
  }

  async ended(thread: string, outcome: "completed" | "failed"): Promise<void> {
    const entry = this.threads.get(thread);
    if (!entry) return this.hold(thread, { kind: "ended", outcome });
    await this.noteEnded(entry, outcome);
    this.changed(entry);
  }

  /** A turn refused before it started: it never ran. */
  cancelled(thread: string): void {
    const entry = this.threads.get(thread);
    if (!entry || entry.open === 0) return;
    entry.open -= 1;
    this.changed(entry, false);
  }

  prompt(thread: string, question: string | undefined): void {
    const entry = this.threads.get(thread);
    if (!entry || entry.question === question) return;
    if (question) entry.question = question;
    else delete entry.question;
    this.changed(entry, false);
  }

  /** The runtime closes; what it used stays in the book for the reports after it. */
  closed(thread: string): void {
    const entry = this.threads.get(thread);
    const live = entry ? this.live(thread) : undefined;
    if (!entry || !live) return;
    if (live.usage) entry.usage = live.usage;
    if (live.model) entry.model = live.model;
    void this.save().catch(() => undefined);
  }

  deleted(thread: string): void {
    const entry = this.threads.get(thread);
    if (!entry || entry.gone) return;
    entry.gone = true;
    entry.open = 0;
    this.changed(entry);
  }

  /** Threads of a transfer, for letting the transfer go. */
  ofTransfer(transfer: string): string[] {
    return [...this.threads.values()].filter((entry) => entry.transfer === transfer).map((entry) => entry.thread);
  }

  /** Whether any thread of the transfer still runs a turn. */
  busy(transfer: string): boolean {
    return this.ofTransfer(transfer).some((thread) => {
      const state = this.derive(this.threads.get(thread)!).state;
      return state === "running" || state === "starting";
    });
  }
}
