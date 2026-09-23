import { useSyncExternalStore } from "react";
import { SquareTerminal } from "lucide-react";
import { tooltipProps } from "tau";
import type { UiTerminalSession } from "./protocol.js";
import { terminalStore } from "./store.js";

/** How often the shells a thread opened are asked what runs in them. */
export const FOREGROUND_POLL_MS = 3_000;

/** Shells of threads whose foreground is a program, not the idle shell. */
class BusyShells {
  private ids: ReadonlySet<string> = new Set();
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = (): ReadonlySet<string> => this.ids;
  set(ids: ReadonlySet<string>): void {
    if (ids.size === this.ids.size && [...ids].every((id) => this.ids.has(id))) return;
    this.ids = ids;
    for (const listener of this.listeners) listener();
  }
}

export const busyShells = new BusyShells();

/** Asks only while a thread has a live shell; `foreground` reads the pty, no process is spawned. */
export function watchForegrounds(foreground: (id: string) => Promise<{ process?: string }>, every = FOREGROUND_POLL_MS): () => void {
  let stopped = false;
  const poll = async () => {
    const live = terminalStore.getSnapshot().sessions.filter((session) => session.sessionId && session.exitCode === undefined);
    const answers = await Promise.all(live.map((session) => foreground(session.id).then((answer) => answer?.process ? session.id : undefined, () => undefined)));
    if (!stopped) busyShells.set(new Set(answers.filter((id): id is string => id !== undefined)));
  };
  const timer = setInterval(() => { void poll(); }, every);
  return () => { stopped = true; clearInterval(timer); busyShells.set(new Set()); };
}

/** Shells a thread opened that run a program right now. */
export function runningShells(sessions: readonly UiTerminalSession[], busy: ReadonlySet<string>, threadId: string): number {
  return sessions.filter((session) => session.sessionId === threadId && session.exitCode === undefined && busy.has(session.id)).length;
}

export function shellLabel(count: number): string {
  return `${count} terminal ${count === 1 ? "process" : "processes"} running`;
}

/** T3 Code's terminal mark on a rail row: a program runs in one of the thread's shells. */
export function TerminalRowStatus({ session }: { session: { id: string } }) {
  const busy = useSyncExternalStore(busyShells.subscribe, busyShells.get);
  const count = useSyncExternalStore(terminalStore.subscribe, () => runningShells(terminalStore.getSnapshot().sessions, busy, session.id));
  if (count === 0) return null;
  const label = shellLabel(count);
  return (
    <span className="terminal-row-status" role="img" aria-label={label} {...tooltipProps(label)}>
      <SquareTerminal size={12} aria-hidden="true" />{count > 1 ? count : null}
    </span>
  );
}
