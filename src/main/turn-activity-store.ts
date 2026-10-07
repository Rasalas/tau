import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UiToolRun, UiTurnActivityEntry } from "../shared/contracts.js";

/**
 * The tool cards of a runtime that keeps no journal Tau can read, one JSON
 * Lines file per thread. A save appends only what changed since the last one;
 * a load folds the lines back into turns. Outputs and long arguments are
 * clipped: the file keeps what a card shows, not every byte a tool printed.
 */
export interface TurnActivityStoreOptions {
  directory: string;
  /** Turns kept per thread, newest last; older ones are dropped at load. */
  maxTurns?: number;
  /** Characters of output kept per tool, from the end. */
  maxOutputChars?: number;
  /** Characters kept of one string argument. */
  maxArgumentChars?: number;
}

type Status = UiTurnActivityEntry["status"];
interface Line { turn: string; anchor?: string; status?: Status; tool?: UiToolRun }
interface Written { status?: Status; anchor?: string; tools: Map<string, string> }

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const STATUSES = new Set<Status>(["running", "completed", "interrupted", "error"]);
const ENDED_EARLY = "The turn ended before this tool finished.";

function fileName(threadId: string): string {
  return SAFE_ID.test(threadId) ? `${threadId}.jsonl` : `${createHash("sha256").update(threadId).digest("hex").slice(0, 40)}.jsonl`;
}

function tool(value: unknown): UiToolRun | undefined {
  const item = value as Partial<UiToolRun> | undefined;
  if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.startedAt !== "number") return undefined;
  if (item.status !== "running" && item.status !== "done" && item.status !== "error") return undefined;
  const args = item.args && typeof item.args === "object" && !Array.isArray(item.args) ? item.args : {};
  return {
    id: item.id,
    name: item.name,
    ...(item.kind === "subagent" ? { kind: item.kind } : {}),
    args,
    ...(Array.isArray(item.media) ? { media: item.media.filter((media) => media && ["image", "audio", "video"].includes(media.type) && typeof media.url === "string") } : {}),
    status: item.status,
    startedAt: item.startedAt,
    ...(typeof item.output === "string" ? { output: item.output } : {}),
    ...(typeof item.endedAt === "number" ? { endedAt: item.endedAt } : {}),
  };
}

function line(value: unknown): Line | undefined {
  const item = value as Partial<Line> | undefined;
  if (!item || typeof item.turn !== "string") return undefined;
  const parsed = item.tool === undefined ? undefined : tool(item.tool);
  if (item.tool !== undefined && !parsed) return undefined;
  return {
    turn: item.turn,
    ...(typeof item.anchor === "string" ? { anchor: item.anchor } : {}),
    ...(item.status && STATUSES.has(item.status) ? { status: item.status } : {}),
    ...(parsed ? { tool: parsed } : {}),
  };
}

/** A settled turn never runs again; what a restart cut short reads as interrupted. */
function settled(entry: UiTurnActivityEntry): UiTurnActivityEntry {
  if (entry.status !== "running") return entry;
  return {
    ...entry,
    status: "interrupted",
    tools: entry.tools.map((run) => run.status === "running" ? { ...run, status: "error", output: run.output || ENDED_EARLY } : run),
  };
}

function fold(lines: readonly Line[]): UiTurnActivityEntry[] {
  const turns = new Map<string, { anchor?: string; status: Status; tools: Map<string, UiToolRun> }>();
  for (const entry of lines) {
    let turn = turns.get(entry.turn);
    if (!turn) {
      turn = { status: "running", tools: new Map() };
      turns.set(entry.turn, turn);
    }
    if (entry.anchor && !turn.anchor) turn.anchor = entry.anchor;
    if (entry.status) turn.status = entry.status;
    if (entry.tool) turn.tools.set(entry.tool.id, entry.tool);
  }
  return [...turns].flatMap(([id, turn]) => turn.tools.size === 0 ? [] : [settled({
    id,
    ...(turn.anchor ? { anchorMessageId: turn.anchor } : {}),
    status: turn.status,
    tools: [...turn.tools.values()].map((run) => run.kind === "subagent" && run.status === "running" ? { ...run, status: "done", args: { ...run.args, agentStatus: "idle" } } : run),
  })]);
}

function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `[Earlier output not kept; the last ${max} characters follow.]\n${text.slice(text.length - max)}`;
}

export class TurnActivityStore {
  private readonly maxTurns: number;
  private readonly maxOutput: number;
  private readonly maxArgument: number;
  /** What this process wrote per thread and turn, so a save appends only the difference. */
  private readonly written = new Map<string, Map<string, Written>>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly options: TurnActivityStoreOptions) {
    this.maxTurns = options.maxTurns ?? 500;
    this.maxOutput = options.maxOutputChars ?? 16_384;
    this.maxArgument = options.maxArgumentChars ?? 4_096;
  }

  private path(threadId: string): string {
    return join(this.options.directory, fileName(threadId));
  }

  private serial<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(threadId) ?? Promise.resolve()).then(work, work);
    this.queues.set(threadId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async readLines(threadId: string): Promise<Line[]> {
    const raw = await readFile(this.path(threadId), "utf8").catch(() => "");
    return raw.split("\n").flatMap((text) => {
      if (!text.trim()) return [];
      try { const parsed = line(JSON.parse(text)); return parsed ? [parsed] : []; } catch { return []; }
    });
  }

  /** Earlier turns, oldest first, under the ids the host gave them. */
  load(threadId: string): Promise<UiTurnActivityEntry[]> {
    return this.serial(threadId, async () => {
      this.written.delete(threadId);
      const lines = await this.readLines(threadId);
      const all = fold(lines);
      const kept = all.slice(-this.maxTurns);
      const size = kept.reduce((sum, entry) => sum + entry.tools.length + 1, 0);
      // Rewrite once the file holds far more lines than the turns it describes.
      if (kept.length < all.length || lines.length > size * 2 + 32) await this.rewrite(threadId, kept);
      return kept;
    });
  }

  private async rewrite(threadId: string, entries: readonly UiTurnActivityEntry[]): Promise<void> {
    const text = entries.flatMap((entry) => [
      JSON.stringify({ turn: entry.id, ...(entry.anchorMessageId ? { anchor: entry.anchorMessageId } : {}), status: entry.status } satisfies Line),
      ...entry.tools.map((run) => JSON.stringify({ turn: entry.id, tool: run } satisfies Line)),
    ]).join("\n");
    const target = this.path(threadId);
    const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
    await mkdir(this.options.directory, { recursive: true });
    await writeFile(temporary, text ? `${text}\n` : "", "utf8");
    await rename(temporary, target);
  }

  /** The host's current record of one turn; later saves of the same turn add what changed. */
  save(threadId: string, entry: UiTurnActivityEntry): Promise<void> {
    return this.serial(threadId, async () => {
      // The host numbers a thread's turns past every id it loaded, so an id names one turn for good.
      const key = entry.id;
      const turns = this.written.get(threadId) ?? new Map<string, Written>();
      this.written.set(threadId, turns);
      const known = turns.get(key) ?? { tools: new Map<string, string>() };
      const lines: Line[] = [];
      if (known.status !== entry.status || (entry.anchorMessageId && known.anchor !== entry.anchorMessageId)) {
        lines.push({ turn: key, status: entry.status, ...(entry.anchorMessageId ? { anchor: entry.anchorMessageId } : {}) });
      }
      for (const run of entry.tools) {
        const kept = this.clipped(run);
        const signature = kept.kind === "subagent" ? createHash("sha256").update(JSON.stringify(kept)).digest("hex")
          : `${kept.status}:${kept.endedAt ?? ""}:${kept.output?.length ?? 0}:${Object.keys(kept.args).length}:${kept.media?.length ? createHash("sha256").update(JSON.stringify(kept.media)).digest("hex") : ""}`;
        if (known.tools.get(run.id) === signature) continue;
        lines.push({ turn: key, tool: kept });
        known.tools.set(run.id, signature);
      }
      known.status = entry.status;
      if (entry.anchorMessageId) known.anchor = entry.anchorMessageId;
      turns.set(key, known);
      if (lines.length === 0) return;
      await mkdir(this.options.directory, { recursive: true });
      await appendFile(this.path(threadId), `${lines.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
    });
  }

  private clipped(run: UiToolRun): UiToolRun {
    const args = Object.fromEntries(Object.entries(run.args).flatMap(([name, value]) => {
      if (typeof value === "string") return [[name, value.length > this.maxArgument ? `${value.slice(0, this.maxArgument)}…` : value]];
      let size = 0;
      try { size = JSON.stringify(value)?.length ?? 0; } catch { return []; }
      return size > this.maxArgument ? [] : [[name, value]];
    }));
    return {
      id: run.id,
      name: run.name,
      ...(run.kind ? { kind: run.kind } : {}),
      args,
      ...(run.media?.length ? { media: run.media } : {}),
      status: run.status,
      startedAt: run.startedAt,
      ...(run.output ? { output: clipTail(run.output, this.maxOutput) } : {}),
      ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    };
  }

  /** Takes a thread's file out, for a trash that may put it back. */
  take(threadId: string): Promise<string | undefined> {
    return this.serial(threadId, async () => {
      const raw = await readFile(this.path(threadId), "utf8").catch(() => undefined);
      await rm(this.path(threadId), { force: true });
      this.written.delete(threadId);
      return raw;
    });
  }

  /** Puts back what `take` answered; anything else is ignored. */
  put(threadId: string, value: unknown): Promise<void> {
    return this.serial(threadId, async () => {
      if (typeof value !== "string" || !value) return;
      await mkdir(this.options.directory, { recursive: true });
      await writeFile(this.path(threadId), value, "utf8");
    });
  }
}
