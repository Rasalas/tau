import { backgroundCount } from "../shared/background-work.js";
import type { ThreadHostEvent, UiBackgroundTask, UiThreadGoal } from "../shared/contracts.js";
import type { HostStopReport, HostTurnObserverSet } from "./host-extensions.js";
import type { QueuedMessages } from "./queued-messages.js";
import { requireCapability, type ThreadBackgroundCapability, type ThreadGoalCapability } from "./runtime-types.js";
import type { ThreadRuntime } from "./thread-runtime.js";

/** How long Stop waits for a runtime to confirm a goal paused before it stops the run anyway. */
const GOAL_PAUSE_MS = 5_000;

export interface ThreadStopPort {
  /** Takes the thread's waiting wakes out at once and answers how many there were. */
  dropWakes(): number;
  /** Holds what the user queued until they send again. */
  holdQueue(): void;
  /** Every kit that may wake the thread hears the stop. */
  observers(): Promise<HostStopReport>;
  abort(): Promise<void>;
  /** What the runtime still runs in the background once the run stopped. */
  background?(): readonly UiBackgroundTask[];
  /** A transcript row that is nobody's message; rejects where the runtime has none. */
  notice(text: string): Promise<void>;
  /** The line as a passing notice, for a runtime without such a row. */
  toast(text: string): void;
  log(label: string, detail: string): void;
}

interface GoalStop { stopped?: string; continues?: string }

/**
 * The user's Stop. Waiting wakes leave first and synchronously, so no idle
 * pump can send one; the goal pauses before the run is told to stop, or the
 * runtime would start its next goal turn; the kits that wake the thread say
 * what they ended, and one status line reports all of it.
 */
export async function stopThread(goals: ThreadGoalCapability | undefined, port: ThreadStopPort): Promise<string | undefined> {
  const dropped = port.dropWakes();
  port.holdQueue();
  const observers = port.observers();
  const goal = await pauseGoalForStop(goals, port);
  await port.abort();
  // Stop ends the turn, not a dev server; the line says what goes on.
  const background = port.background?.() ?? [];
  const answered = await observers;
  const report = background.length
    ? { ...answered, continues: [...answered.continues, `${backgroundCount(background)} ${background.length === 1 ? "keeps" : "keep"} running in the background (${background.map((task) => task.label).join(", ")}); stop ${background.length === 1 ? "it" : "them"} above the composer`] }
    : answered;
  // A kit that woke the thread while it was answering the stop is too late.
  const line = stopLine(goal, report, dropped + port.dropWakes());
  if (!line) return undefined;
  port.log("thread.stopped", line);
  try {
    await port.notice(line);
  } catch {
    port.toast(line);
  }
  return line;
}

async function pauseGoalForStop(goals: ThreadGoalCapability | undefined, port: ThreadStopPort): Promise<GoalStop | undefined> {
  const goal = goals?.current();
  if (!goals || goal?.status !== "active") return undefined;
  if (!goal.actions.pause) return { continues: "The goal stays set and goes on with your next message" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([goals.pause(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no answer")), GOAL_PAUSE_MS); })]);
    return { stopped: "goal paused" };
  } catch (error) {
    port.log("goal.pause-failed", error instanceof Error ? error.message : String(error));
    return { continues: "The runtime did not confirm the goal paused; it may start another turn" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One line under the stopped turn; nothing when Stop only ended a turn. Never claims quiet while work goes on. */
export function stopLine(goal: GoalStop | undefined, report: HostStopReport, dropped: number): string | undefined {
  const stopped = [
    ...(goal?.stopped ? [goal.stopped] : []),
    ...report.stopped,
    ...(dropped > 0 ? [dropped === 1 ? "dropped a waiting wake" : `dropped ${dropped} waiting wakes`] : []),
  ];
  const continues = [...(goal?.continues ? [goal.continues] : []), ...report.continues];
  if (stopped.length === 0 && continues.length === 0) return undefined;
  return `${["Stopped", ...stopped].join(" · ")}. ${continues.length > 0 ? `${continues.join(". ")}.` : "Nothing wakes this thread until you start it again."}`;
}

export type GoalAction = "set" | "pause" | "resume" | "clear" | "dismiss";

/** The goal controls of a thread's runtime; `prompt` sends the turn a goal starts with as an ordinary prompt. */
export async function controlGoal(goals: ThreadGoalCapability, action: GoalAction, objective: string | undefined, port: { prompt(text: string): Promise<void>; publish(): void }): Promise<void> {
  if (action === "set") {
    const text = objective?.trim();
    if (!text) throw new Error("Name the goal: /goal <objective>.");
    const start = await goals.set(text);
    port.publish();
    await port.prompt(start?.prompt ?? text);
    return;
  }
  if (action === "resume") {
    const start = await goals.resume();
    port.publish();
    if (start?.prompt) await port.prompt(start.prompt);
    return;
  }
  if (action === "pause") await goals.pause();
  else if (action === "clear") await goals.clear();
  else await (goals.dismiss ?? goals.clear)();
  port.publish();
}

/** A copy the index may keep: the runtime's object may change under it. */
export function publishedGoal(goals: ThreadGoalCapability | undefined): UiThreadGoal | undefined {
  const goal = goals?.current();
  return goal ? { ...goal, actions: { ...goal.actions } } : undefined;
}

export interface ThreadControlsPort {
  queue: Pick<QueuedMessages, "dropWakes" | "hold">;
  turnObservers: Pick<HostTurnObserverSet, "stopped">;
  abortThread(thread: ThreadRuntime): Promise<void>;
  reopenThread(sessionId: string): Promise<ThreadRuntime>;
  /** Sends a turn the way the composer does. */
  prompt(threadId: string, text: string): Promise<void>;
  /** Republishes the detail when the thread is the one on screen. */
  publishDetail(thread: ThreadRuntime): Promise<void>;
  emitForThread(thread: ThreadRuntime, event: ThreadHostEvent): void;
  setGoal(threadId: string, goal: UiThreadGoal | undefined): void;
  setBackground(threadId: string, tasks: UiBackgroundTask[] | undefined): void;
  log(label: string, detail: string): void;
}

/** A copy the index may keep; none for no work. */
export function publishedBackground(background: ThreadBackgroundCapability | undefined): UiBackgroundTask[] | undefined {
  const tasks = background?.current() ?? [];
  return tasks.length ? tasks.map((task) => ({ ...task })) : undefined;
}

/** Stop and goals for the host: what the window's Stop and a kit's `sessions.abort` do, and the goal methods. */
export class ThreadControls {
  constructor(private readonly port: ThreadControlsPort) {}

  stop = async (thread: ThreadRuntime): Promise<void> => {
    const { port } = this;
    await stopThread(thread.backend.capabilities.goals, {
      dropWakes: () => port.queue.dropWakes(thread.threadId).length,
      holdQueue: () => port.queue.hold(thread.threadId),
      observers: () => port.turnObservers.stopped(thread.threadId),
      abort: () => port.abortThread(thread),
      background: () => thread.backend.capabilities.background?.current() ?? [],
      notice: async (text) => {
        const notice = thread.backend.capabilities.resume?.notice;
        if (!notice) throw new Error("no transcript row");
        await notice(text);
        await port.publishDetail(thread);
      },
      toast: (text) => port.emitForThread(thread, { type: "notice", sessionId: thread.threadId, message: text, level: "info" }),
      log: (label, detail) => port.log(label, `${thread.threadId.slice(0, 8)} · ${detail}`),
    });
  };

  goal = async (sessionId: string, action: GoalAction, objective?: string): Promise<void> => {
    const thread = await this.port.reopenThread(sessionId);
    await controlGoal(requireCapability(thread.backend, "goals"), action, objective, {
      prompt: (text) => this.port.prompt(thread.threadId, text),
      publish: () => this.publishGoal(thread),
    });
    this.port.log("goal.changed", `${thread.threadId.slice(0, 8)} · ${action}`);
  };

  publishGoal = (thread: ThreadRuntime): void => {
    this.port.setGoal(thread.threadId, publishedGoal(thread.backend.capabilities.goals));
  };

  /** Stops one background task of the thread, or all of them without an id. */
  stopBackground = async (sessionId: string, taskId?: string): Promise<void> => {
    const thread = await this.port.reopenThread(sessionId);
    await requireCapability(thread.backend, "background").stop(taskId);
    this.publishBackground(thread);
    this.port.log("background.stopped", `${thread.threadId.slice(0, 8)} · ${taskId ?? "all"}`);
  };

  publishBackground = (thread: ThreadRuntime): void => {
    this.port.setBackground(thread.threadId, publishedBackground(thread.backend.capabilities.background));
  };
}
