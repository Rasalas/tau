import type { UiBackgroundTask } from "tau/host-extension";
import { displayCommand } from "./events.js";

interface Command { id: string; label: string; processId?: string; startedAt: number; background: boolean; stopping?: boolean; blocksCompletion?: boolean }

/** How a background command ended, for the wake that tells the agent. */
export interface EndedCommand { label: string; exitCode?: number; output?: string }

/**
 * Commands Codex keeps running after their turn completed (its background
 * terminals). Codex reports their end as a late `item/completed`; it does not
 * start a turn for it, so the backend wakes the thread.
 */
export class CodexBackgroundCommands {
  private readonly commands = new Map<string, Command>();
  private readonly results = new Map<string, UiBackgroundTask>();

  constructor(private readonly now: () => number) {}

  current(): UiBackgroundTask[] {
    return [...this.list().filter((task) => this.commands.get(task.id)?.background || task.state === "reported")];
  }

  list(): UiBackgroundTask[] {
    return [...this.commands.values()].map((command): UiBackgroundTask => ({ id: command.id, kind: "command", label: command.label, startedAt: command.startedAt,
      ...(command.blocksCompletion === false ? { blocksCompletion: false } : {}),
    })).concat([...this.results.values()].map((task) => ({ ...task })));
  }

  release(taskId: string): void {
    const command = this.commands.get(taskId);
    if (!command) throw new Error("That background command is no longer running.");
    command.blocksCompletion = false;
  }

  reported(): string[] { return [...this.results.keys()]; }
  handled(ids: readonly string[]): boolean {
    let changed = false;
    for (const id of ids) if (this.results.delete(id)) changed = true;
    return changed;
  }

  processOf(id: string): string | undefined { return this.commands.get(id)?.processId; }
  has(id: string): boolean { return this.commands.get(id)?.background === true || this.results.has(id); }

  /** Answers whether the background list changed, and the command that ended in the background. */
  push(method: string, params: Record<string, unknown>): { changed: boolean; ended?: EndedCommand } {
    const item = params.item as Record<string, unknown> | undefined;
    if (item?.type !== "commandExecution" || typeof item.id !== "string") return { changed: false };
    if (method === "item/started" && item.status === "inProgress") {
      this.commands.set(item.id, {
        id: item.id,
        label: displayCommand(String(item.command ?? "")) || "Command",
        ...(typeof item.processId === "string" ? { processId: item.processId } : {}),
        startedAt: this.now(),
        background: false,
      });
      return { changed: false };
    }
    if (method !== "item/completed") return { changed: false };
    const command = this.commands.get(item.id);
    this.commands.delete(item.id);
    if (!command?.background) return { changed: false };
    // The user stopped it; the agent hears nothing of that.
    if (command.stopping) return { changed: true };
    if (command.blocksCompletion !== false) this.results.set(command.id, { id: command.id, kind: "command", label: command.label, startedAt: command.startedAt, state: "reported" });
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput.trim() : "";
    return { changed: true, ended: { label: command.label, ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}), ...(output ? { output } : {}) } };
  }

  /** Its end, which may arrive before the stop's answer, wakes nobody; false undoes it. */
  stopping(id: string, value: boolean): void {
    const command = this.commands.get(id);
    if (command) command.stopping = value;
  }

  forget(id: string): void { this.commands.delete(id); this.results.delete(id); }

  /** The turn completed; what still runs runs in the background. */
  turnCompleted(): boolean {
    let changed = false;
    for (const command of this.commands.values()) if (!command.background) { command.background = true; changed = true; }
    return changed;
  }

  /** A failed or interrupted turn, or a gone process: nothing of it reports again. */
  dropForeground(): void {
    for (const [id, command] of this.commands) if (!command.background) this.commands.delete(id);
  }

  clear(): boolean {
    const had = this.current().length > 0;
    this.commands.clear();
    this.results.clear();
    return had;
  }
}

const TAIL_LINES = 20;

/** The wake's text: what ended, how, and the end of its output. */
export function endedCommandText(command: EndedCommand): string {
  const how = command.exitCode === undefined ? "ended" : `ended with exit code ${command.exitCode}`;
  const tail = command.output ? `\n\nLast output:\n${command.output.split("\n").slice(-TAIL_LINES).join("\n")}` : "";
  return `The background command \`${command.label}\` ${how}.${tail}`;
}
