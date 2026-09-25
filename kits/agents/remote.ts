import type { HostMachineServices } from "tau/host-extension";
// Remote Work lends this typed client of its thread service and the types it
// speaks; nothing else of that kit is reachable from here (ADR 0020).
import type { RemoteThreadsService } from "../remote-work/threads-client.js";
import type { RemoteThreadLink, RemoteThreadStartInput, RemoteThreadWaitResult } from "../remote-work/protocol.js";
import { AUTO_MACHINE, isBusyStatus, isLocalMachine, type AgentMachineRef, type AgentWorkspace, type ChooseMachineAnswer } from "./protocol.js";
import type { AgentThreadBook, ThreadLiveness } from "./threads.js";

/**
 * A child there is looked at this often: a `wait` that long while it runs,
 * so its thread id, cost and state arrive between turns too, and a pause that
 * long while it asks something or its machine is away.
 */
const POLL_MS = 5_000;
/** How long an idle answer right after a send is taken for the report before the turn. */
const SEND_GRACE_MS = 60_000;
/** Until a machine said how many cores it has. */
export const DEFAULT_MACHINE_BUDGET = 2;
const RESOURCES_TIMEOUT_MS = 20_000;
const PANEL_RESULT_LIMIT = 240;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const truncate = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
const BUSY_THERE = new Set(["sending", "starting", "running"]);

export interface RemoteChildrenOptions {
  service: RemoteThreadsService;
  book: AgentThreadBook;
  machines(): HostMachineServices | undefined;
  /** An agent's record moved; `moved` says whether the panel needs it. */
  changed(id: string, moved: boolean): void;
  /** A turn of a child there ended: the same bookkeeping as a turn here. */
  ended(id: string, outcome: "completed" | "failed"): Promise<void>;
  save(): void;
  log(label: string, detail?: string): void;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  pollMs?: number;
}

/** A machine a spawn resolved to; `undefined` machine is this computer. */
export interface MachineChoice {
  machine?: { id: string; name: string };
  /** Why, when Tau chose. */
  reason?: string;
}

export type MachineSource = "tool" | "definition" | "setting";

const SOURCE_HINT: Record<MachineSource, string> = {
  tool: "",
  definition: " The agent definition names it.",
  setting: ' Sub-agents go there by Settings → Agents; pass machine "local" to run this one here.',
};

/**
 * Where a spawn runs: this computer, a machine this host's agents reach, or
 * the one Machines Kit picks for `auto`. A machine that cannot take work now
 * fails the spawn with the reason, never falls back quietly.
 */
export async function resolveMachine(
  wanted: string | undefined,
  source: MachineSource,
  ports: { machines(): HostMachineServices | undefined; auto(): Promise<ChooseMachineAnswer | undefined> },
): Promise<MachineChoice> {
  if (!wanted || isLocalMachine(wanted)) return {};
  let name = wanted.trim();
  let reason: string | undefined;
  if (name.toLowerCase() === AUTO_MACHINE) {
    const answer = await ports.auto();
    if (!answer) return { reason: "Automatic choice needs Machines Kit's choose-machine; this computer runs it." };
    if (!answer.machine) return { reason: answer.reason };
    name = answer.machine;
    reason = answer.reason;
  }
  const machines = ports.machines();
  if (!machines) throw new Error(`This host keeps no other machines for its agents, so none runs on ${name}.${SOURCE_HINT[source]}`);
  if (name === machines.self.id || name.toLowerCase() === machines.self.name.toLowerCase()) return reason ? { reason } : {};
  const all = machines.list();
  const named = all.filter((machine) => machine.name.toLowerCase() === name.toLowerCase());
  const machine = all.find((candidate) => candidate.id === name) ?? (named.length === 1 ? named[0] : undefined);
  if (!machine) {
    const known = all.map((entry) => entry.name).join(", ");
    throw new Error(named.length > 1
      ? `More than one machine is called ${name}; name it by its id.${SOURCE_HINT[source]}`
      : `This computer's agents know no machine ${name}${known ? ` (they know ${known})` : ""}.${SOURCE_HINT[source]}`);
  }
  if (machine.status !== "connected") throw new Error(`${machine.name} is ${machine.status}${machine.detail ? `: ${machine.detail}` : ""}.${SOURCE_HINT[source]}`);
  if (machine.readOnly) throw new Error(`${machine.name} lets this computer's agents in Read only; a sub-agent there needs Full access.${SOURCE_HINT[source]}`);
  return { machine: { id: machine.id, name: machine.name }, ...(reason ? { reason } : {}) };
}

/** A remote child's checkout as the panel and the tools show it: the worktree there, and its branch here once back. */
function workspaceOf(link: RemoteThreadLink, before: AgentWorkspace | undefined): AgentWorkspace | undefined {
  if (!link.transfer && !before) return undefined;
  const branch = link.result?.state === "branch" ? link.result.branch : link.transfer ? `tau/remote-${link.transfer}` : before?.branch;
  const changes = link.result?.state === "branch"
    ? { files: link.result.files, added: 0, removed: 0, commits: link.result.commits, uncommitted: 0 }
    : link.result?.state === "nothing" ? { files: 0, added: 0, removed: 0, commits: 0, uncommitted: 0 } : undefined;
  return {
    mode: "worktree",
    path: link.worktree ?? before?.path ?? "",
    ...(branch ? { branch } : {}),
    ...(changes ? { changes } : {}),
    ...(link.settled ? { settled: link.settled.how === "applied" ? "applied" : "discarded" } : {}),
  };
}

/**
 * Agents that run on another machine. Each is a link of Remote Work's thread
 * service; this follows it with a `wait` in the background and writes what it
 * learns into the same book local agents live in, so the tools, the wake-ups
 * and the panel treat both alike.
 */
export class RemoteChildren {
  private readonly links = new Map<string, RemoteThreadLink>();
  /** Turns of each child already told to the book. */
  private readonly turns = new Map<string, number>();
  private readonly following = new Set<string>();
  /** A follow asked for while one runs: it looks once more before it stops. */
  private readonly again = new Set<string>();
  private readonly sent = new Map<string, { turns: number; at: number }>();
  private readonly budgets = new Map<string, number>();
  private readonly reading = new Map<string, Promise<void>>();
  /** Threads on a machine that run for someone else here (a handoff, the user), by machine. */
  private readonly foreign = new Map<string, number>();
  private closed = false;

  constructor(private readonly options: RemoteChildrenOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private get pollMs(): number {
    return this.options.pollMs ?? POLL_MS;
  }

  private sleep(ms: number): Promise<void> {
    return this.options.sleep ? this.options.sleep(ms) : new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
  }

  close(): void {
    this.closed = true;
  }

  /** The book's liveness of a child there: busy while its state travels or it runs, holding while it asks. */
  liveness(id: string): ThreadLiveness | undefined {
    const link = this.links.get(id);
    const state = link?.status === "offline" ? link.there?.state : link?.status;
    if (state && BUSY_THERE.has(state)) return { streaming: true, idle: false };
    if (state === "waiting") return { streaming: false, idle: false };
    return undefined;
  }

  /** The last answer there, as long as that machine sends it. */
  answer(id: string): string | undefined {
    return this.links.get(id)?.there?.lastMessage;
  }

  turnsOf(id: string): number {
    return this.links.get(id)?.there?.turns ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Budget per machine: its cores, unless it said nothing yet

  budget(machine: string): number {
    return this.budgets.get(machine) ?? DEFAULT_MACHINE_BUDGET;
  }

  knownBudget(machine: string): number | undefined {
    return this.budgets.get(machine);
  }

  /** Whether the machine an agent waits for has a free slot; an agent here always has. */
  hasRoom(machine: string | undefined): boolean {
    if (!machine) return true;
    return this.options.book.busyOn(machine) + (this.foreign.get(machine) ?? 0) < this.budget(machine);
  }

  /**
   * Reads what a machine's budget needs before a spawn claims a slot there:
   * its cores, once (the first reading watches its CPU for a few seconds),
   * and how many threads run there for something else than this kit.
   */
  async prepare(machine: string): Promise<void> {
    if (!this.budgets.has(machine)) {
      let reading = this.reading.get(machine);
      if (!reading) {
        reading = this.readCores(machine).finally(() => this.reading.delete(machine));
        this.reading.set(machine, reading);
      }
      await reading;
    }
    try {
      const ours = new Set([...this.links.values()].map((link) => link.id));
      const active = await this.options.service.list({ machine, active: true });
      this.foreign.set(machine, active.filter((link) => !ours.has(link.id) && (BUSY_THERE.has(link.status) || link.status === "waiting")).length);
    } catch (error) {
      this.options.log("agents.remote-list-failed", `${machine}: ${errorText(error)}`);
    }
  }

  private async readCores(machine: string): Promise<void> {
    try {
      const resources = await this.options.machines()?.request(machine, "host-resources", [], { timeoutMs: RESOURCES_TIMEOUT_MS }) as { cpuCount?: unknown } | undefined;
      const cores = typeof resources?.cpuCount === "number" && resources.cpuCount > 0 ? Math.floor(resources.cpuCount) : undefined;
      if (cores) this.budgets.set(machine, cores);
    } catch (error) {
      this.options.log("agents.remote-cores-unknown", `${machine}: ${errorText(error)}; ${DEFAULT_MACHINE_BUDGET} at a time until it answers`);
    }
  }

  // ---------------------------------------------------------------------------
  // One child's life there

  /** Starts the child's thread there; the link answers at once, the state travels in the background. */
  async start(id: string, input: RemoteThreadStartInput): Promise<void> {
    const link = await this.options.service.start(input);
    await this.apply(id, link);
    this.options.save();
    void this.follow(id);
  }

  /** Reads a child's link again after this host restarted, and follows it when it is not done. */
  async restore(id: string, tries = 24): Promise<void> {
    const ref = this.options.book.linkFor(id)?.machine;
    if (!ref?.link) return;
    for (let attempt = 0; attempt < tries && !this.closed; attempt += 1) {
      try {
        const link = await this.options.service.get(ref.link);
        await this.apply(id, link, true);
        if (BUSY_THERE.has(link.status) || link.status === "waiting" || link.status === "offline") void this.follow(id);
        return;
      } catch (error) {
        const text = errorText(error);
        // Remote Work may activate after this kit; anything else is final.
        if (!/is not active|is not installed/u.test(text)) {
          this.options.changed(id, this.options.book.noteError(id, `Lost track of it on ${ref.name}: ${text}`));
          return;
        }
        await this.sleep(this.pollMs);
      }
    }
  }

  /** Writes what the link says into the book; a turn that ended there ends here. */
  async apply(id: string, link: RemoteThreadLink, initial = false): Promise<void> {
    const { book } = this.options;
    const before = book.linkFor(id);
    if (!before?.machine) return;
    this.links.set(id, link);
    const there = link.there;
    const ref: AgentMachineRef = {
      id: link.machine,
      name: link.machineName,
      link: link.id,
      ...(link.thread ? { thread: link.thread } : {}),
      ...(link.status === "offline" ? { offline: true } : {}),
      ...(link.usage?.costUsd !== undefined ? { costUsd: link.usage.costUsd } : {}),
      ...(before.machine.reason ? { reason: before.machine.reason } : {}),
    };
    let moved = book.noteMachine(id, ref);
    const workspace = workspaceOf(link, before.workspace);
    if (JSON.stringify(workspace) !== JSON.stringify(before.workspace)) moved = book.noteWorkspace(id, workspace) || moved;
    const question = there?.state === "waiting" ? there.question : undefined;
    if (question !== before.pendingToolPrompt) moved = book.notePrompt(id, question) || moved;
    if (there && there.state !== "starting") moved = book.noteAccepted(id) || moved;
    if (link.status === "failed" && !link.thread) moved = book.noteError(id, link.error ?? `It never started on ${link.machineName}.`) || moved;
    if (link.status === "gone" && !before.error) moved = book.noteError(id, `Its thread was deleted on ${link.machineName}.`) || moved;

    const turns = there?.turns ?? 0;
    const seen = this.turns.get(id);
    if (initial || seen === undefined && !there) this.turns.set(id, turns);
    else if (there && turns > (seen ?? 0) && !BUSY_THERE.has(there.state)) {
      this.turns.set(id, turns);
      const answer = there.lastMessage ?? (there.state === "failed" ? there.error : undefined);
      if (answer) moved = book.noteResult(id, truncate(answer, PANEL_RESULT_LIMIT)) || moved;
      this.options.changed(id, moved);
      await this.options.ended(id, there.outcome === "failed" || there.outcome === "interrupted" ? "failed" : "completed");
      return;
    }
    this.options.changed(id, moved);
  }

  /**
   * Follows a child until its turn is over there: a `wait` at a time, a look
   * every few seconds while it asks something or the machine is away.
   */
  async follow(id: string): Promise<void> {
    if (this.closed) return;
    if (this.following.has(id)) {
      this.again.add(id);
      return;
    }
    this.following.add(id);
    try {
      for (;;) {
        this.again.delete(id);
        const ref = this.options.book.linkFor(id)?.machine;
        if (this.closed || !ref?.link) return;
        let answer: RemoteThreadWaitResult;
        try {
          answer = await this.options.service.wait(ref.link, this.pollMs);
        } catch (error) {
          if (this.closed) return;
          const text = errorText(error);
          this.options.log("agents.remote-follow-failed", `${id.slice(0, 8)}: ${text}`);
          if (/No thread link/u.test(text)) {
            this.options.changed(id, this.options.book.noteError(id, `Lost track of it on ${ref.name}: ${text}`));
            return;
          }
          await this.sleep(this.pollMs);
          continue;
        }
        if (this.closed) return;
        await this.apply(id, answer.link);
        if (answer.reason === "timeout") continue;
        const sent = this.sent.get(id);
        if (sent && (answer.link.there?.turns ?? 0) <= sent.turns && this.now() - sent.at < SEND_GRACE_MS && (answer.reason === "idle" || answer.reason === "failed")) {
          // The report before the new turn; the turn itself comes next.
          await this.sleep(Math.min(1_000, this.pollMs));
          continue;
        }
        this.sent.delete(id);
        if (answer.reason === "waiting" || answer.reason === "offline") {
          await this.sleep(this.pollMs);
          continue;
        }
        if (!this.again.has(id)) return;
      }
    } finally {
      this.following.delete(id);
    }
  }

  private refOf(id: string): AgentMachineRef & { link: string } {
    const ref = this.options.book.linkFor(id)?.machine;
    if (!ref?.link) throw new Error("That thread has not reached its machine yet.");
    return ref as AgentMachineRef & { link: string };
  }

  /** Whether it runs a turn there now, as far as this side knows. */
  running(id: string): boolean {
    return this.liveness(id)?.streaming === true;
  }

  async send(id: string, text: string, delivery: "prompt" | "steer" | "queue"): Promise<void> {
    const ref = this.refOf(id);
    this.sent.set(id, { turns: this.turnsOf(id), at: this.now() });
    await this.apply(id, await this.options.service.send(ref.link, text, delivery));
    void this.follow(id);
  }

  async abort(id: string): Promise<void> {
    const ref = this.refOf(id);
    await this.apply(id, await this.options.service.abort(ref.link));
    void this.follow(id);
  }

  /** Waits a little for a stopped turn to end there, for a restart. */
  async settleTurn(id: string, timeoutMs: number): Promise<void> {
    const ref = this.refOf(id);
    const answer = await this.options.service.wait(ref.link, timeoutMs);
    await this.apply(id, answer.link);
  }

  /**
   * Brings the work back and merges it, or lets it go; either way the
   * worktree there goes and the thread moves to that machine's trash. A
   * conflict leaves all of it as it was and answers the link unsettled.
   */
  async settle(id: string, how: "apply" | "discard"): Promise<RemoteThreadLink> {
    const ref = this.refOf(id);
    const link = await this.options.service.settle(ref.link, how, { removeThread: true });
    await this.apply(id, link);
    this.options.save();
    return link;
  }

  /** How many of this book's agents are busy on each machine, for the settings list. */
  busy(machine: string): number {
    return [...this.links.keys()].filter((id) => {
      const link = this.options.book.linkFor(id);
      return link?.machine?.id === machine && isBusyStatus(link.status);
    }).length;
  }
}
