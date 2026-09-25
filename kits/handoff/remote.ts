import {
  HostCommandError,
  smallCompletionModel,
  type HostExtensionContext,
  type HostMachine,
  type HostMachineServices,
  type HostReadiness,
  type HostThread,
} from "tau/host-extension";
import { REMOTE_WORK_EXTENSION_ID, type RemoteThreadLink } from "../remote-work/protocol.js";
import {
  conversationText,
  excerptSummary,
  handoffRequest,
  mergeBackRequest,
  messagesAfter,
  messagesFromEntries,
  modelName,
  nameFromEntries,
  summaryBody,
  titleOf,
  whereFrom,
  withoutBlocks,
  writeSummary,
  type ConversationMessage,
} from "./handoff.js";
import {
  HANDOFF_EXTENSION_ID,
  HANDOFF_TAG,
  MERGE_BACK_TAG,
  NATIVE_FORK_RUNTIMES,
  REMOTE_MERGE_BACK_COMMAND,
  TARGETS_EVENT,
  formatBlock,
  type ContinueOnInput,
  type ContinueOnResult,
  type ContinueTarget,
  type HandoffStrategy,
  type PrepareMergeBackResult,
  type RemoteMergeBackResult,
  type TargetRuntime,
} from "./protocol.js";

/** What the kit keeps about a thread here that continues on another machine. */
export interface RemoteRecord {
  link: string;
  machine: string;
  machineName: string;
  strategy: HandoffStrategy;
  createdAt: number;
  /** The last message here when the history went along; the summary there starts after it. */
  through?: string;
  /** Where the last bring-back this thread was sent ended there. */
  mergedThrough?: string;
  broughtAt?: number;
  /** A bring-back in this thread's composer, committed once a prompt carries it. */
  pending?: string;
}

export interface RemoteContinuationsOptions {
  context: HostExtensionContext;
  get(threadId: string): RemoteRecord | undefined;
  set(threadId: string, record: RemoteRecord | undefined): void;
  /** The thread, open and not in a turn. */
  openThread(threadId: string): HostThread;
  now(): number;
}

/** A machine's readiness is asked again after this long, or when a menu opens. */
const READINESS_TTL_MS = 60_000;
const READINESS_TIMEOUT_MS = 15_000;
/** The summary there runs on a small model; `call` waits 30 s by default. */
const MERGE_BACK_TIMEOUT_MS = 120_000;
/** A link in these states holds nothing any more: the thread may continue elsewhere again. */
const OVER: readonly RemoteThreadLink["status"][] = ["settled", "failed", "gone"];

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const STATE_NOTES: Record<string, string> = {
  "sign-in-required": "not signed in",
  "not-installed": "not installed",
  unavailable: "unavailable",
  checking: "still checking",
};

function targetRuntimes(readiness: HostReadiness): TargetRuntime[] {
  return (readiness.runtimes ?? []).map((runtime) => ({
    kind: runtime.kind,
    label: runtime.label,
    ready: runtime.state === "ready",
    ...(runtime.state === "ready" ? {} : { note: runtime.note ?? STATE_NOTES[runtime.state] ?? runtime.state }),
  }));
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? "" : "s"}`;
}

/**
 * "Continue on <machine>" and "Bring back" (H08): a thread here goes on as an
 * ordinary thread on another machine, through Remote Work Kit's thread
 * service, and stays usable here like a fork. Pi's history goes along
 * natively (`sessions.import` there); any other runtime starts there with the
 * handoff block before the composer's message. Bringing it back fetches its
 * branch and asks this kit there for the merge-back summary.
 */
export class RemoteContinuations {
  private readonly readiness = new Map<string, { at: number; runtimes?: TargetRuntime[]; error?: string }>();
  private readonly asking = new Map<string, Promise<void>>();
  private stop?: () => void;

  constructor(private readonly options: RemoteContinuationsOptions) {}

  private get services() {
    return this.options.context.services;
  }

  private machines(): HostMachineServices {
    const machines = this.services.machines;
    if (!machines) throw new HostCommandError("This host reaches no other machines.");
    return machines;
  }

  private remoteWork<T>(command: string, input: unknown): Promise<T> {
    return this.options.context.invokeHostExtension(REMOTE_WORK_EXTENSION_ID, command, input) as Promise<T>;
  }

  /** Follows the machines: a machine that connects is asked what runs there. */
  open(): void {
    const machines = this.services.machines;
    if (!machines) return;
    this.stop = machines.subscribe(() => {
      this.emit();
      void this.refresh(false);
    });
    void this.refresh(false);
  }

  close(): void {
    this.stop?.();
  }

  private usable(): HostMachine[] {
    return (this.services.machines?.list() ?? []).filter((machine) => machine.status === "connected" && !machine.readOnly);
  }

  targets(): ContinueTarget[] {
    return this.usable().map((machine) => {
      const known = this.readiness.get(machine.id);
      return {
        id: machine.id,
        name: machine.name,
        ...(known?.runtimes ? { runtimes: known.runtimes } : {}),
        ...(known?.error ? { error: known.error } : {}),
      };
    });
  }

  private emit(): void {
    this.options.context.emit(TARGETS_EVENT, this.targets());
  }

  /** Asks the machines whose readiness is unknown or old, or all of them with `force`. */
  async refresh(force: boolean): Promise<ContinueTarget[]> {
    const machines = this.services.machines;
    if (!machines) return [];
    const now = this.options.now();
    await Promise.all(this.usable().map((machine) => {
      const known = this.readiness.get(machine.id);
      if (!force && known && now - known.at < READINESS_TTL_MS) return undefined;
      const running = this.asking.get(machine.id);
      if (running) return running;
      const asking = machines.request(machine.id, "readiness", [], { timeoutMs: READINESS_TIMEOUT_MS })
        .then((answer) => { this.readiness.set(machine.id, { at: this.options.now(), runtimes: targetRuntimes(answer as HostReadiness) }); })
        .catch((error: unknown) => { this.readiness.set(machine.id, { at: this.options.now(), error: errorText(error) }); })
        .finally(() => {
          this.asking.delete(machine.id);
          this.emit();
        });
      this.asking.set(machine.id, asking);
      return asking;
    }));
    return this.targets();
  }

  private machine(name: string): HostMachine {
    const all = this.machines().list();
    const byName = all.filter((machine) => machine.name.toLowerCase() === name.trim().toLowerCase());
    const machine = all.find((candidate) => candidate.id === name) ?? (byName.length === 1 ? byName[0] : undefined);
    if (!machine) throw new HostCommandError(`This computer's agents do not know a machine ${name}.`);
    if (machine.status !== "connected") throw new HostCommandError(`${machine.name} is ${machine.status}${machine.detail ? `: ${machine.detail}` : ""}.`);
    if (machine.readOnly) throw new HostCommandError(`${machine.name} lets this computer's agents in Read only; a thread there needs Full access.`);
    return machine;
  }

  /** Refuses a runtime the machine reports as not ready; a machine that does not answer gets the benefit of the doubt. */
  private async assertReady(machine: HostMachine, backend: string): Promise<void> {
    await this.refresh(false);
    const runtime = this.readiness.get(machine.id)?.runtimes?.find((candidate) => candidate.kind === backend);
    if (runtime && !runtime.ready) throw new HostCommandError(`${runtime.label} is ${runtime.note ?? "not ready"} on ${machine.name}; sign in there first.`);
    if (this.readiness.get(machine.id)?.runtimes && !runtime) throw new HostCommandError(`${machine.name} has no ${backend} runtime.`);
  }

  private async link(id: string): Promise<RemoteThreadLink | undefined> {
    return this.remoteWork<RemoteThreadLink>("thread", { link: id }).catch(() => undefined);
  }

  async continueOn(input: ContinueOnInput): Promise<ContinueOnResult> {
    const thread = this.options.openThread(input.threadId);
    const machine = this.machine(input.machine);
    const before = this.options.get(thread.sessionId);
    if (before) {
      const link = await this.link(before.link);
      if (link && !OVER.includes(link.status)) throw new HostCommandError(`This thread continues on ${before.machineName} already; bring it back or let it go first.`);
    }
    const messages = await thread.transcript();
    if (!messages.some((message) => message.role === "assistant" && message.text.trim())) {
      throw new HostCommandError("There is nothing to hand over yet: the thread has no answer.");
    }
    const native = NATIVE_FORK_RUNTIMES.includes(thread.backendKind);
    const prompt = input.prompt?.trim();
    if (!native && !prompt) throw new HostCommandError(`Write what ${machine.name} should do next in the composer first; the thread starts there with it.`);
    await this.assertReady(machine, thread.backendKind);

    const title = titleOf(thread.sessionName(), messages);
    const here = this.machines().self.name;
    const source = whereFrom(title, thread.backendKind, modelName(thread.model));
    let text = prompt;
    if (!native) {
      const model = await smallCompletionModel(this.services, thread.model);
      const written = await writeSummary(
        (request, chosen) => this.services.complete(request, chosen),
        model,
        handoffRequest(conversationText(messages), { source, cwd: thread.cwd }),
        () => excerptSummary(messages),
      );
      this.services.log("handoff.remote-summary", written.model ?? `excerpt: ${written.fallback ?? ""}`);
      const header = `Continued from ${source} on ${here}. What happened there, as background for the message below:`;
      text = `${formatBlock(HANDOFF_TAG, header, summaryBody(written))}\n\n${prompt}`;
    }
    const last = messages.at(-1);
    const link = await this.remoteWork<RemoteThreadLink>("thread-start", {
      machine: machine.id,
      cwd: thread.cwd,
      title,
      parentThreadId: thread.sessionId,
      ...(native ? { session: { threadId: thread.sessionId } } : { backend: thread.backendKind }),
      ...(text ? { prompt: text } : {}),
      ...(thread.model ? { model: { provider: thread.model.provider, id: thread.model.id } } : {}),
    });
    this.options.set(thread.sessionId, {
      link: link.id,
      machine: machine.id,
      machineName: machine.name,
      strategy: native ? "native" : "portable",
      createdAt: this.options.now(),
      ...(native && last ? { through: last.sourceEntryId ?? last.id } : {}),
    });
    this.services.log("handoff.continue-on", `${thread.sessionId.slice(0, 8)} → ${machine.name} (${native ? "native" : "portable"})`);
    return { link: link.id, machine: machine.id, machineName: machine.name, native };
  }

  private record(threadId: string): RemoteRecord {
    const record = this.options.get(threadId);
    if (!record) throw new HostCommandError("This thread does not continue on another machine.");
    return record;
  }

  /**
   * Brings the work back as a branch here and asks the machine for the
   * merge-back summary of what happened there since it went, or since it was
   * last brought back. The block goes to this thread's composer for review.
   */
  async bringBack(threadId: string): Promise<PrepareMergeBackResult> {
    const record = this.record(threadId);
    const fetched = await this.remoteWork<RemoteThreadLink>("thread-result", { link: record.link });
    if (!fetched.thread) throw new HostCommandError(`The thread never started on ${record.machineName}.`);
    const result = fetched.result;
    const files = result?.state === "branch" ? result.paths ?? [] : [];
    const since = record.mergedThrough ?? record.through;
    let header = `Brought back from ${fetched.machineName}:`;
    let summary: string;
    let through = since ?? "";
    try {
      const answer = await this.machines().call(fetched.machine, HANDOFF_EXTENSION_ID, REMOTE_MERGE_BACK_COMMAND, {
        threadId: fetched.thread,
        ...(since ? { through: since } : {}),
        again: Boolean(record.mergedThrough),
        files,
      }, { timeoutMs: MERGE_BACK_TIMEOUT_MS }) as RemoteMergeBackResult;
      header = answer.header;
      summary = answer.summary;
      through = answer.through;
    } catch (error) {
      // The branch is here either way; the summary is what the other machine could not write.
      summary = `_No summary came back from ${fetched.machineName} (${errorText(error)})._`;
    }
    const branch = result?.state === "branch"
      ? `Its work came back as the branch \`${result.branch}\` here (${plural(result.commits, "commit")}, ${plural(result.files, "file")}).`
      : `No file changed on ${fetched.machineName}.`;
    this.options.set(threadId, { ...record, ...(through ? { pending: through } : {}) });
    return { parentThreadId: threadId, context: formatBlock(MERGE_BACK_TAG, header, `${branch}\n\n${summary}`), through };
  }

  /** A prompt carrying the bring-back reached this thread: the next one starts after it. */
  commit(threadId: string): boolean {
    const record = this.options.get(threadId);
    if (!record?.pending) return false;
    const { pending, ...rest } = record;
    this.options.set(threadId, { ...rest, mergedThrough: pending, broughtAt: this.options.now() });
    return true;
  }

  /** `apply` merges the branch when clean and lets the worktree there go; `discard` lets it go at once. */
  async settle(threadId: string, how: "apply" | "discard"): Promise<RemoteThreadLink> {
    const record = this.record(threadId);
    const link = await this.remoteWork<RemoteThreadLink>("thread-settle", { link: record.link, how });
    if (link.status === "settled") this.options.set(threadId, undefined);
    return link;
  }

  /**
   * There: the summary of a thread another machine continued here, for its
   * bring-back. The thread need not be open; a Pi session is read from its file.
   */
  async mergeBackHere(input: { threadId: string; through?: string; again?: boolean; files: string[] }): Promise<RemoteMergeBackResult> {
    const { services } = this;
    const live = services.thread(input.threadId);
    let messages: ConversationMessage[];
    let name: string | undefined;
    let backend: string;
    let model: { provider: string; id: string } | undefined;
    let cwd: string;
    if (live) {
      if (live.isStreaming()) throw new HostCommandError("The thread is still working here; wait for its turn to end.");
      messages = await live.transcript();
      name = live.sessionName();
      backend = live.backendKind;
      model = live.model;
      cwd = live.cwd;
    } else {
      const found = (await services.sessions.list()).find((session) => session.sessionId === input.threadId);
      if (!found) throw new HostCommandError(`This machine has no thread ${input.threadId}.`);
      const session = services.sessions.open(found.path);
      const entries = session.entries();
      messages = messagesFromEntries(entries);
      name = nameFromEntries(entries);
      backend = "pi";
      cwd = session.cwd;
    }
    const delta = messagesAfter(messages, input.through)
      .map((message) => ({ ...message, text: message.role === "user" ? withoutBlocks(message.text) : message.text }))
      .filter((message) => message.text.trim());
    if (!delta.some((message) => message.role === "assistant")) {
      throw new HostCommandError(input.through ? "Nothing new since it was last brought back." : "The thread has no answer to bring back yet.");
    }
    const here = services.machines?.self.name ?? "another machine";
    const source = whereFrom(titleOf(name, messages), backend, modelName(model));
    const small = await smallCompletionModel(services, model);
    const written = await writeSummary(
      (request, chosen) => services.complete(request, chosen),
      small,
      mergeBackRequest(conversationText(delta), input.files, { source, cwd }),
      () => excerptSummary(delta, input.files),
    );
    services.log("handoff.remote-merge-back", written.model ?? `excerpt: ${written.fallback ?? ""}`);
    const since = input.again ? "since it was last brought back" : "since it went there";
    const last = messages.at(-1);
    return {
      header: `Brought back from ${source} on ${here}, ${plural(delta.length, "message")} ${since}:`,
      summary: summaryBody(written),
      through: last ? last.sourceEntryId ?? last.id ?? "" : "",
    };
  }
}
