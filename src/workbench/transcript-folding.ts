import type { UiToolRun } from "../shared/contracts";

/**
 * How much of a turn's work the transcript shows. `focused` reads a settled
 * turn as prose — one fold row instead of the log; `detailed` keeps the groups
 * open with their arguments and thinking; `everything` adds the raw output.
 */
export type TranscriptDetail = "focused" | "detailed" | "everything";

export const TRANSCRIPT_DETAIL_LEVELS: readonly TranscriptDetail[] = ["focused", "detailed", "everything"];

export function isTranscriptDetail(value: unknown): value is TranscriptDetail {
  return typeof value === "string" && (TRANSCRIPT_DETAIL_LEVELS as readonly string[]).includes(value);
}

export function nextTranscriptDetail(level: TranscriptDetail): TranscriptDetail {
  const index = TRANSCRIPT_DETAIL_LEVELS.indexOf(level);
  return TRANSCRIPT_DETAIL_LEVELS[(index + 1) % TRANSCRIPT_DETAIL_LEVELS.length];
}

/** What a run of tools did, as a group summary and a live line can say it. */
export type ToolActionClass = "read" | "write" | "command" | "search" | "other";

export interface ToolFact {
  id: string;
  action: ToolActionClass;
  /** A named source — a browser, computer use, an MCP server — hoisted to the front of a summary. */
  source?: string;
  /** Distinct target of a change, so a group counts files instead of calls. */
  path?: string;
  /** What the live line says the tool is working on. */
  subject?: string;
  /** The tool's own name, the fallback the live line falls back to. */
  title: string;
  failed: boolean;
  running: boolean;
}

/** What the caller knows about a tool beyond its own record; a tool renderer supplies it. */
export interface ToolPresentationHint {
  source?: string;
  title?: string;
  detail?: string;
}

const COMMAND_TOOLS = new Set(["bash", "powershell", "shell", "sh", "zsh", "run_command", "execute_command"]);
const WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "multiedit", "apply_patch", "str_replace", "notebook_edit", "create_file"]);
const READ_TOOLS = new Set(["read", "cat", "view", "read_file", "open_file", "notebook_read"]);
const SEARCH_TOOLS = new Set(["grep", "glob", "find", "ls", "list", "search", "ripgrep", "codebase_search"]);

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** `mcp__linear__create_issue` is the MCP naming convention, not a kit's private spelling. */
function mcpSource(name: string): string | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const server = name.split("__")[1];
  return server ? server.replaceAll(/[-_]/gu, " ") : undefined;
}

export function toolActionClass(name: string): ToolActionClass {
  const lower = name.toLowerCase();
  if (COMMAND_TOOLS.has(lower)) return "command";
  if (WRITE_TOOLS.has(lower)) return "write";
  if (READ_TOOLS.has(lower)) return "read";
  if (SEARCH_TOOLS.has(lower)) return "search";
  return "other";
}

/** The program a shell command runs, which is all a live line needs to name it. */
export function commandProgram(command: string | undefined): string | undefined {
  const first = command?.trim().split(/\s+/u)[0];
  if (!first) return undefined;
  const program = first.split(/[\\/]/u).at(-1);
  return program && !program.includes("=") ? program : undefined;
}

/** The arguments that say what a call did, in the order a reader looks for them. */
const TELLING_ARGS = ["command", "file_path", "path", "notebook_path", "pattern", "query", "url", "description", "prompt"];

function oneLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

/**
 * What a call was about, for a tool no renderer claimed: the value of its most
 * telling argument rather than the argument names.
 */
export function toolArgumentSummary(args: Readonly<Record<string, unknown>>): string {
  const telling = TELLING_ARGS.map((key) => args[key]).find((value) => typeof value === "string" && value.trim());
  const first = telling ?? Object.values(args).find((value) => typeof value === "string" && value.trim());
  if (typeof first === "string") return oneLine(first);
  // No text to show: the names are all there is.
  return Object.keys(args).join(" · ") || "no arguments";
}

const EXIT_STATUS = /\bexit(?:ed with)? code -?\d+/iu;
const FAILURE_REASON_CHARS = 240;

/**
 * Why a failed tool failed, in one line: a shell's exit status with the last
 * thing it printed, or else the first line of what the tool answered.
 */
export function toolFailureReason(output: string | undefined): string | undefined {
  const lines = (output ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const status = lines.find((line) => EXIT_STATUS.test(line));
  const said = status ? lines.filter((line) => line !== status).at(-1) : undefined;
  const reason = status ? (said ? `${status}: ${said}` : status) : lines[0];
  return reason.length > FAILURE_REASON_CHARS ? `${reason.slice(0, FAILURE_REASON_CHARS - 1)}…` : reason;
}

export function classifyToolRun(tool: UiToolRun, hint: ToolPresentationHint = {}): ToolFact {
  const action = toolActionClass(tool.name);
  const path = text(tool.args.path) ?? text(tool.args.file_path);
  const source = hint.source ?? mcpSource(tool.name);
  const subject = action === "command"
    ? commandProgram(text(tool.args.command)) ?? hint.detail
    : path ?? text(tool.args.pattern) ?? text(tool.args.query) ?? hint.detail;
  return {
    id: tool.id,
    action,
    ...(source ? { source } : {}),
    ...(action === "write" && path ? { path: path.replaceAll("\\", "/") } : {}),
    ...(subject ? { subject } : {}),
    title: hint.title ?? tool.name,
    failed: tool.status === "error",
    running: tool.status === "running",
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function times(count: number): string {
  return count === 1 ? "once" : `${count} times`;
}

function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? "";
  return `${clauses.slice(0, -1).join(", ")} and ${clauses.at(-1)}`;
}

function actionClause(action: ToolActionClass, facts: readonly ToolFact[]): string {
  switch (action) {
    case "read": return `read ${plural(facts.length, "file", "files")}`;
    case "write": {
      // A file changed twice is one file; a change with no path of its own still counts.
      const paths = new Set(facts.flatMap((fact) => fact.path ? [fact.path] : []));
      const unnamed = facts.filter((fact) => !fact.path).length;
      return `changed ${plural(paths.size + unnamed, "file", "files")}`;
    }
    case "command": return `ran ${plural(facts.length, "command", "commands")}`;
    case "search": return `searched code ${times(facts.length)}`;
    default: return `used ${plural(facts.length, "tool", "tools")}`;
  }
}

/**
 * One sentence for a run of tools: what it did, by action class, with named
 * sources first. "Used N tools" is the fallback bucket, never the headline.
 */
export function summarizeToolFacts(facts: readonly ToolFact[]): string {
  if (facts.length === 0) return "";
  const sources = new Map<string, number>();
  const actions = new Map<ToolActionClass, ToolFact[]>();
  for (const fact of facts) {
    if (fact.source) {
      sources.set(fact.source, (sources.get(fact.source) ?? 0) + 1);
      continue;
    }
    const bucket = actions.get(fact.action) ?? [];
    bucket.push(fact);
    actions.set(fact.action, bucket);
  }
  const clauses = [
    ...[...sources].map(([name, count]) => `used ${name} ${times(count)}`),
    ...[...actions].map(([action, bucket]) => actionClause(action, bucket)),
  ];
  const sentence = joinClauses(clauses);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

const LIVE_VERBS: Record<ToolActionClass, [present: string, past: string]> = {
  read: ["Reading", "Read"],
  write: ["Editing", "Edited"],
  command: ["Running", "Ran"],
  search: ["Searching", "Searched"],
  other: ["Using", "Used"],
};

/** The live line's own sentence; the same row says it in the past once the tool settles. */
export function liveActivityLabel(fact: ToolFact, present: boolean): string {
  const [running, done] = LIVE_VERBS[fact.action];
  const verb = present ? running : done;
  const subject = fact.subject ?? fact.source ?? fact.title;
  return `${verb} ${subject}`;
}

export function formatWorkDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The ticking clock over a running turn: 0:47, then 1:02:30. */
export function formatLiveClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(total % 60).padStart(2, "0");
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds}`;
}

export type WorkRow =
  /** A batch a registered tool card draws itself; never folded, grouped or hidden. */
  | { kind: "card"; id: string; cardId: string; tools: readonly UiToolRun[] }
  /** The settled turn as one line; its rows come back in place when it is opened. */
  | { kind: "fold"; id: string; label: string; rows: readonly WorkRow[]; open: boolean; failed: boolean }
  /** The one self-replacing line of a turn in flight. */
  | { kind: "live"; id: string; label: string; startedAt: number; tools: readonly UiToolRun[] }
  | {
      kind: "group";
      id: string;
      summary: string;
      tools: readonly UiToolRun[];
      failed: boolean;
      open: boolean;
      /** How the turn as a whole ended, marked once on the row that leads it. */
      note?: "error" | "interrupted";
    };

export interface WorkGroupInput {
  /** Stable id of the turn's activity entry; every row key derives from it. */
  id: string;
  tools: readonly UiToolRun[];
  status: "running" | "completed" | "interrupted" | "error";
  /** When the turn's final assistant message arrived; tools after it are trailing. */
  answerAt?: number;
  detail: TranscriptDetail;
  /** A run is actually in flight for this thread. */
  streaming?: boolean;
  now: number;
  /** The card that draws this tool, when one is registered. */
  cardIdFor?(tool: UiToolRun): string | undefined;
  presentationOf?(tool: UiToolRun): ToolPresentationHint;
  /** The reader opened some of this turn's work while it ran; its fold starts open. */
  keepOpen?: boolean;
}

/** Lifecycle updates arrive as repeats of one call; the last record wins. */
function distinctTools(tools: readonly UiToolRun[]): UiToolRun[] {
  const byId = new Map<string, UiToolRun>();
  for (const tool of tools) byId.set(tool.id, tool);
  return [...byId.values()];
}

function toolEnd(tool: UiToolRun, now: number): number {
  return tool.endedAt ?? now;
}

function groupRow(id: string, tools: readonly UiToolRun[], input: WorkGroupInput, open: boolean): WorkRow {
  const facts = tools.map((tool) => classifyToolRun(tool, input.presentationOf?.(tool) ?? {}));
  return {
    kind: "group",
    id,
    summary: summarizeToolFacts(facts),
    tools,
    failed: facts.some((fact) => fact.failed) || input.status === "error",
    open,
  };
}

/** Consecutive runs, split where a failure sits, so a failure is never papered over. */
function groupedRows(tools: readonly UiToolRun[], input: WorkGroupInput, key: string): WorkRow[] {
  const rows: WorkRow[] = [];
  let run: UiToolRun[] = [];
  const flush = () => {
    if (run.length === 0) return;
    rows.push(groupRow(`${key}:g${rows.length}`, run, input, input.detail !== "focused"));
    run = [];
  };
  for (const tool of tools) {
    if (tool.status === "error") {
      flush();
      rows.push(groupRow(`${key}:g${rows.length}`, [tool], input, true));
      continue;
    }
    run.push(tool);
  }
  flush();
  return rows;
}

function cardSegments(tools: readonly UiToolRun[], cardIdFor: WorkGroupInput["cardIdFor"]): Array<{ cardId?: string; tools: UiToolRun[] }> {
  const segments: Array<{ cardId?: string; tools: UiToolRun[] }> = [];
  for (const tool of tools) {
    const cardId = cardIdFor?.(tool);
    const last = segments.at(-1);
    if (last && last.cardId === cardId) last.tools.push(tool);
    else segments.push({ ...(cardId ? { cardId } : {}), tools: [tool] });
  }
  return segments;
}

function liveRow(tools: readonly UiToolRun[], input: WorkGroupInput): { row: WorkRow; rest: UiToolRun[] } | undefined {
  // The live line owns the trailing run of tools that did not fail; a failure
  // drops out of it and keeps its own row.
  let start = tools.length;
  while (start > 0 && tools[start - 1].status !== "error") start -= 1;
  if (start === tools.length) return undefined;
  const live = tools.slice(start);
  const newest = [...live].reverse().find((tool) => tool.status === "running") ?? live.at(-1)!;
  const fact = classifyToolRun(newest, input.presentationOf?.(newest) ?? {});
  return {
    row: {
      kind: "live",
      id: `${input.id}:live`,
      label: liveActivityLabel(fact, newest.status === "running"),
      startedAt: Math.min(...live.map((tool) => tool.startedAt)),
      tools: live,
    },
    rest: tools.slice(0, start),
  };
}

function foldLabel(tools: readonly UiToolRun[], input: WorkGroupInput): string {
  const started = Math.min(...tools.map((tool) => tool.startedAt));
  const ended = Math.max(...tools.map((tool) => toolEnd(tool, input.now)), input.answerAt ?? 0);
  const duration = formatWorkDuration(ended - started);
  return input.status === "interrupted" ? `Stopped after ${duration}` : `Worked for ${duration}`;
}

/**
 * The rows one turn's work becomes. Pure: every input the shape depends on is
 * an argument, so the transcript components hold no derivation of their own.
 */
export function deriveWorkRows(input: WorkGroupInput): WorkRow[] {
  const tools = distinctTools(input.tools);
  if (tools.length === 0) return [];
  const rows: WorkRow[] = [];
  for (const segment of cardSegments(tools, input.cardIdFor)) {
    if (segment.cardId) {
      rows.push({ kind: "card", id: `${input.id}:card:${segment.tools[0].id}`, cardId: segment.cardId, tools: segment.tools });
      continue;
    }
    rows.push(...workRowsFor(segment.tools, input, `${input.id}:${segment.tools[0].id}`));
  }
  return rows;
}

/** A turn that failed or was stopped says so once, on the row that leads it. */
function noteTerminalStatus(rows: WorkRow[], input: WorkGroupInput): WorkRow[] {
  if (input.status !== "error" && input.status !== "interrupted") return rows;
  const first = rows.findIndex((row) => row.kind === "group");
  if (first < 0) return rows;
  rows[first] = { ...rows[first] as Extract<WorkRow, { kind: "group" }>, note: input.status };
  return rows;
}

function workRowsFor(tools: readonly UiToolRun[], input: WorkGroupInput, key: string): WorkRow[] {
  const live = input.streaming && input.status === "running" ? liveRow(tools, input) : undefined;
  if (live) return [...groupedRows(live.rest, input, key), live.row];
  if (input.detail !== "focused" || input.status === "running") return noteTerminalStatus(groupedRows(tools, input, key), input);

  // A settled turn folds everything up to its answer, failures included. After
  // the answer a single tool that did not fail still belongs to the turn; more,
  // or a failure, is new work and stays where the reader can see it.
  const answerAt = input.answerAt;
  const trailing = answerAt === undefined ? [] : tools.filter((tool) => tool.startedAt > answerAt);
  const keepTrailing = trailing.length > 1 || trailing.some((tool) => tool.status === "error");
  const folded = keepTrailing ? tools.filter((tool) => !trailing.includes(tool)) : tools;
  if (folded.length === 0) return noteTerminalStatus(groupedRows(tools, input, key), input);
  const fold: WorkRow = {
    kind: "fold",
    id: `${key}:fold`,
    label: foldLabel(folded, input),
    // The fold row carries the turn's own failure; a row inside fails by its own tools.
    rows: groupedRows(folded, { ...input, detail: "detailed", status: "completed" }, `${key}:fold`),
    open: input.keepOpen === true,
    failed: input.status === "error",
  };
  return keepTrailing ? [fold, ...groupedRows(trailing, input, `${key}:t`)] : [fold];
}

/**
 * The turn's answer, for the trailing rule: the last assistant message after
 * the group's anchor, or the anchor's own timestamp when it is that message.
 */
export function answerTimestampAfter(
  messages: readonly { id: string; role: string; text: string; timestamp: number }[],
  anchorMessageId: string | undefined,
): number | undefined {
  const anchor = anchorMessageId === undefined ? -1 : messages.findIndex((message) => message.id === anchorMessageId);
  let answerAt: number | undefined;
  for (let index = anchor + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role === "assistant" && message.text.trim()) answerAt = message.timestamp;
  }
  return answerAt;
}
