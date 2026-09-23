import { useSyncExternalStore } from "react";
import { SquareTerminal } from "lucide-react";
import { tooltipProps } from "tau";
import type { UiTerminalSession } from "./protocol.js";
import { terminalStore } from "./store.js";

/** Shells a thread opened that are still running; one that exited no longer counts. */
export function openShells(sessions: readonly UiTerminalSession[], threadId: string): number {
  return sessions.filter((session) => session.sessionId === threadId && session.exitCode === undefined).length;
}

export function shellLabel(count: number): string {
  return `${count} terminal${count === 1 ? "" : "s"} open`;
}

/** T3 Code's terminal mark on a rail row: the thread still has a shell of its own. */
export function TerminalRowStatus({ session }: { session: { id: string } }) {
  const count = useSyncExternalStore(terminalStore.subscribe, () => openShells(terminalStore.getSnapshot().sessions, session.id));
  if (count === 0) return null;
  const label = shellLabel(count);
  return (
    <span className="terminal-row-status" role="img" aria-label={label} {...tooltipProps(label)}>
      <SquareTerminal size={12} aria-hidden="true" />{count > 1 ? count : null}
    </span>
  );
}
