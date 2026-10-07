import type { UiMessage, UiWake } from "./contracts.js";

export interface AsyncActivity {
  label: string;
  detail: string;
  attention?: boolean;
  /** A kit woke the thread; the transcript draws a wake line. */
  wake?: UiWake;
}

const WAKE_HEAD = /^\[Tau wake: ([a-z][a-z0-9-]{0,31})\] ([^\n]+)(?:\n\n([\s\S]*))?$/u;

/** The text a wake is delivered as: its line first, then what the agent should know. */
export function wakeMessageText(wake: UiWake, body: string): string {
  const source = /^[a-z][a-z0-9-]{0,31}$/u.test(wake.source) ? wake.source : "tau";
  const label = wake.label.replace(/\s+/gu, " ").trim().slice(0, 160) || "Woken";
  const detail = body.trim();
  return detail ? `[Tau wake: ${source}] ${label}\n\n${detail}` : `[Tau wake: ${source}] ${label}`;
}

/** A message sent in the user's name by a runtime or by Tau: a quiet line instead of a bubble. */
export function parseAsyncActivity(text: string): AsyncActivity | undefined {
  const wake = WAKE_HEAD.exec(text);
  if (wake) return { label: wake[2]!, detail: wake[3] ?? "", wake: { source: wake[1]!, label: wake[2]! } };
  if (text.startsWith("Subagent needs attention:")) {
    return { label: "Subagent needs attention", detail: text, attention: true };
  }
  // Tau's own notes, e.g. Agents Kit waking a thread whose sub-agent finished (design 1n).
  if (text.startsWith("[Tau] ")) return { label: text.slice(6).split("\n")[0].replace(/\.$/u, ""), detail: text };
  if (!text.startsWith("Background task completed:")) return undefined;

  const count = /completed with (\d+) child run\(s\)/i.exec(text)?.[1];
  const label = count
    ? `${count} subagent ${count === "1" ? "run" : "runs"} completed`
    : "Background task completed";
  return { label, detail: text };
}

/** A prompt of the user's own starts a turn; a note sent in their name does not. */
export function startsTurn(message: UiMessage): boolean {
  return message.role === "user" && !parseAsyncActivity(message.text);
}

/** The number of the turn `message` starts: the host's own where it set one, else the one after `previous`. */
export function turnNumberOf(previous: number, message: UiMessage): number {
  return message.turnNumber ?? previous + 1;
}

/** The number of the last turn the messages hold; with older turns not loaded it still counts them. */
export function lastTurnNumber(messages: readonly UiMessage[]): number {
  let number = 0;
  for (const message of messages) if (startsTurn(message)) number = turnNumberOf(number, message);
  return number;
}

/**
 * A window that leaves older turns out numbers its first prompt, so a client
 * that never loaded those turns still says which one it shows.
 */
export function numberWindowTurns(all: readonly UiMessage[], start: number, end: number): UiMessage[] {
  const window = all.slice(start, end);
  if (start === 0) return window;
  const first = window.findIndex(startsTurn);
  if (first < 0) return window;
  const before = all.slice(0, start + first).filter(startsTurn).length;
  window[first] = { ...window[first]!, turnNumber: before + 1 };
  return window;
}
