import { describe, expect, it } from "vitest";
import type { UiToolRun } from "../shared/contracts";
import {
  answerTimestampAfter,
  classifyToolRun,
  commandProgram,
  deriveWorkRows,
  formatLiveClock,
  formatWorkDuration,
  isTranscriptDetail,
  liveActivityLabel,
  nextTranscriptDetail,
  summarizeToolFacts,
  toolActionClass,
  toolArgumentSummary,
  toolFailureReason,
  type WorkGroupInput,
  type WorkRow,
} from "./transcript-folding";

const NOW = 1_000_000;

function tool(partial: Partial<UiToolRun> & Pick<UiToolRun, "id" | "name">): UiToolRun {
  return {
    args: {},
    status: "done",
    startedAt: NOW - 10_000,
    endedAt: NOW - 9_000,
    ...partial,
  };
}

function input(partial: Partial<WorkGroupInput> & Pick<WorkGroupInput, "tools">): WorkGroupInput {
  return { id: "turn-1", status: "completed", detail: "focused", now: NOW, ...partial };
}

function summaries(rows: readonly WorkRow[]): string[] {
  return rows.map((row) => row.kind === "group" ? row.summary : row.kind === "fold" ? row.label : row.kind === "live" ? row.label : `card:${row.cardId}`);
}

describe("classification", () => {
  it("names the action class from the tool's own name", () => {
    expect(toolActionClass("bash")).toBe("command");
    expect(toolActionClass("PowerShell")).toBe("command");
    expect(toolActionClass("edit")).toBe("write");
    expect(toolActionClass("read")).toBe("read");
    expect(toolActionClass("grep")).toBe("search");
    expect(toolActionClass("tau_spawn_thread")).toBe("other");
  });

  it("takes an MCP server as the tool's source", () => {
    expect(classifyToolRun(tool({ id: "1", name: "mcp__linear_app__create_issue" })).source).toBe("linear app");
    expect(classifyToolRun(tool({ id: "1", name: "read" })).source).toBeUndefined();
  });

  it("prefers a tool renderer's own source and title", () => {
    const fact = classifyToolRun(tool({ id: "1", name: "preview_click" }), { source: "the browser", title: "Click" });
    expect(fact.source).toBe("the browser");
    expect(fact.title).toBe("Click");
  });

  it("keeps the changed path so a group can count files", () => {
    expect(classifyToolRun(tool({ id: "1", name: "edit", args: { path: "src\\app.ts" } })).path).toBe("src/app.ts");
    expect(classifyToolRun(tool({ id: "1", name: "read", args: { path: "src/app.ts" } })).path).toBeUndefined();
  });

  it("reads the program out of a shell command", () => {
    expect(commandProgram("/usr/bin/npm run test")).toBe("npm");
    expect(commandProgram("FOO=1 npm test")).toBeUndefined();
    expect(commandProgram("   ")).toBeUndefined();
  });
});

describe("summaries", () => {
  const read = (id: string, path: string) => classifyToolRun(tool({ id, name: "read", args: { path } }));
  const edit = (id: string, path: string) => classifyToolRun(tool({ id, name: "edit", args: { path } }));
  const run = (id: string) => classifyToolRun(tool({ id, name: "bash", args: { command: "npm test" } }));
  const search = (id: string) => classifyToolRun(tool({ id, name: "grep", args: { pattern: "x" } }));

  it("says what each action class did", () => {
    expect(summarizeToolFacts([read("1", "a"), read("2", "b"), read("3", "c")])).toBe("Read 3 files");
    expect(summarizeToolFacts([edit("1", "a")])).toBe("Changed 1 file");
    expect(summarizeToolFacts([run("1"), run("2"), run("3"), run("4")])).toBe("Ran 4 commands");
    expect(summarizeToolFacts([search("1"), search("2"), search("3")])).toBe("Searched code 3 times");
    expect(summarizeToolFacts([search("1")])).toBe("Searched code once");
  });

  it("counts distinct files for a change, not calls", () => {
    expect(summarizeToolFacts([edit("1", "a.ts"), edit("2", "a.ts"), edit("3", "b.ts")])).toBe("Changed 2 files");
  });

  it("still counts a change with no path of its own", () => {
    const anonymous = classifyToolRun(tool({ id: "9", name: "apply_patch" }));
    expect(summarizeToolFacts([edit("1", "a.ts"), anonymous])).toBe("Changed 2 files");
  });

  it("joins the classes it saw into one sentence", () => {
    expect(summarizeToolFacts([read("1", "a"), read("2", "b"), read("3", "c"), run("4"), run("5")]))
      .toBe("Read 3 files and ran 2 commands");
    expect(summarizeToolFacts([read("1", "a"), edit("2", "b"), run("3")]))
      .toBe("Read 1 file, changed 1 file and ran 1 command");
  });

  it("falls back to the bucket only for tools with no class", () => {
    const other = classifyToolRun(tool({ id: "1", name: "todo_write" }));
    expect(summarizeToolFacts([other, classifyToolRun(tool({ id: "2", name: "todo_write" }))])).toBe("Used 2 tools");
  });

  it("hoists a named source to the front", () => {
    const browser = classifyToolRun(tool({ id: "1", name: "preview_click" }), { source: "the browser" });
    expect(summarizeToolFacts([read("2", "a"), browser, read("3", "b")]))
      .toBe("Used the browser once and read 2 files");
  });

  it("has nothing to say about no tools", () => {
    expect(summarizeToolFacts([])).toBe("");
  });
});

describe("durations", () => {
  it("reads a work duration as prose", () => {
    expect(formatWorkDuration(45_000)).toBe("45s");
    expect(formatWorkDuration(134_000)).toBe("2m 14s");
    expect(formatWorkDuration(120_000)).toBe("2m");
    expect(formatWorkDuration(3_900_000)).toBe("1h 05m");
    expect(formatWorkDuration(0)).toBe("1s");
  });

  it("reads a running clock as a clock", () => {
    expect(formatLiveClock(47_000)).toBe("0:47");
    expect(formatLiveClock(62_000)).toBe("1:02");
    expect(formatLiveClock(3_750_000)).toBe("1:02:30");
  });
});

describe("live activity line", () => {
  it("says the present tense", () => {
    const fact = classifyToolRun(tool({ id: "1", name: "read", args: { path: "src/app.ts" }, status: "running" }));
    expect(liveActivityLabel(fact)).toBe("Reading src/app.ts");
  });

  it("keeps the present tense after the newest tool settles", () => {
    const rows = deriveWorkRows(input({ status: "running", streaming: true, tools: [tool({ id: "1", name: "read", args: { path: "a.ts" } })] }));
    expect(rows[0]).toMatchObject({ kind: "live", label: "Reading a.ts" });
  });

  it("names the program of a command", () => {
    const fact = classifyToolRun(tool({ id: "1", name: "bash", args: { command: "npm run build" } }));
    expect(liveActivityLabel(fact)).toBe("Running npm");
  });

  it("collapses the trailing run into one row with a stable key", () => {
    const rows = deriveWorkRows(input({
      id: "t",
      status: "running",
      streaming: true,
      tools: [
        tool({ id: "1", name: "read", args: { path: "a.ts" } }),
        tool({ id: "2", name: "read", args: { path: "b.ts" }, status: "running", endedAt: undefined, startedAt: NOW - 3_000 }),
      ],
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "live", id: "t:live", label: "Reading b.ts", startedAt: NOW - 10_000 });
  });

  it("drops a failing tool out of the live row", () => {
    const rows = deriveWorkRows(input({
      id: "t",
      status: "running",
      streaming: true,
      tools: [
        tool({ id: "1", name: "bash", args: { command: "npm test" }, status: "error" }),
        tool({ id: "2", name: "read", args: { path: "b.ts" }, status: "running", endedAt: undefined }),
      ],
    }));
    expect(rows.map((row) => row.kind)).toEqual(["group", "live"]);
    expect(rows[0]).toMatchObject({ failed: true, open: true });
  });

  it("has no live row when the newest tool failed", () => {
    const rows = deriveWorkRows(input({
      status: "running",
      streaming: true,
      tools: [tool({ id: "1", name: "bash", args: { command: "npm test" }, status: "error" })],
    }));
    expect(rows.map((row) => row.kind)).toEqual(["group"]);
  });
});

describe("turn fold", () => {
  const work = [
    tool({ id: "1", name: "read", args: { path: "a.ts" }, startedAt: NOW - 134_000, endedAt: NOW - 130_000 }),
    tool({ id: "2", name: "edit", args: { path: "a.ts" }, startedAt: NOW - 20_000, endedAt: NOW - 10_000 }),
  ];

  it("folds a settled turn into one row", () => {
    const rows = deriveWorkRows(input({ tools: work }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "fold", label: "Worked for 2m 4s" });
  });

  it("keeps the hidden rows on the fold so it opens in place", () => {
    const [fold] = deriveWorkRows(input({ tools: work }));
    expect(fold.kind).toBe("fold");
    expect(fold.kind === "fold" ? summaries(fold.rows) : []).toEqual(["Read 1 file and changed 1 file"]);
    expect(fold.kind === "fold" ? fold.rows.every((row) => row.kind === "group" && row.open) : false).toBe(true);
  });

  it("says the turn was stopped when it was interrupted", () => {
    const rows = deriveWorkRows(input({ tools: work, status: "interrupted" }));
    expect(rows[0]).toMatchObject({ kind: "fold", label: "Stopped after 2m 4s" });
  });

  it("folds a failed call with the rest of the turn and opens it in its own row", () => {
    const rows = deriveWorkRows(input({ tools: [...work, tool({ id: "3", name: "bash", status: "error" })] }));
    expect(rows.map((row) => row.kind)).toEqual(["fold"]);
    expect(rows[0]).toMatchObject({ open: false, failed: false });
    const inside = rows[0].kind === "fold" ? rows[0].rows : [];
    expect(inside.map((row) => row.kind === "group" && row.failed)).toEqual([false, true]);
  });

  it("folds a turn that ended in an error and marks the fold", () => {
    const rows = deriveWorkRows(input({ tools: work, status: "error" }));
    expect(rows).toEqual([expect.objectContaining({ kind: "fold", failed: true })]);
    expect(rows[0].kind === "fold" && rows[0].rows.every((row) => row.kind === "group" && !row.failed)).toBe(true);
  });

  it("keeps a failure after the answer out of the fold", () => {
    const rows = deriveWorkRows(input({
      tools: [...work, tool({ id: "3", name: "bash", args: { command: "npm test" }, status: "error", startedAt: NOW - 5_000 })],
      answerAt: NOW - 8_000,
    }));
    expect(rows.map((row) => row.kind)).toEqual(["fold", "group"]);
    expect(rows[1]).toMatchObject({ failed: true, open: true, summary: "Ran 1 command" });
  });

  it("starts the fold open when the reader opened some of the turn while it ran", () => {
    expect(deriveWorkRows(input({ tools: work, keepOpen: true }))[0]).toMatchObject({ kind: "fold", open: true });
    expect(deriveWorkRows(input({ tools: work }))[0]).toMatchObject({ kind: "fold", open: false });
  });

  it("lets a single non-failing trailing tool join the fold", () => {
    const trailing = tool({ id: "3", name: "read", args: { path: "c.ts" }, startedAt: NOW - 5_000 });
    const rows = deriveWorkRows(input({ tools: [...work, trailing], answerAt: NOW - 8_000 }));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind === "fold" ? summaries(rows[0].rows) : []).toEqual(["Read 2 files and changed 1 file"]);
  });

  it("keeps a larger trailing run out of the fold", () => {
    const rows = deriveWorkRows(input({
      tools: [
        ...work,
        tool({ id: "3", name: "read", args: { path: "c.ts" }, startedAt: NOW - 5_000 }),
        tool({ id: "4", name: "read", args: { path: "d.ts" }, startedAt: NOW - 4_000 }),
      ],
      answerAt: NOW - 8_000,
    }));
    expect(rows.map((row) => row.kind)).toEqual(["fold", "group"]);
    expect(summaries(rows)).toEqual(["Worked for 2m 6s", "Read 2 files"]);
  });

  it("does not fold at all when every tool is trailing", () => {
    const rows = deriveWorkRows(input({
      tools: [
        tool({ id: "3", name: "read", args: { path: "c.ts" }, startedAt: NOW - 5_000 }),
        tool({ id: "4", name: "read", args: { path: "d.ts" }, startedAt: NOW - 4_000 }),
      ],
      answerAt: NOW - 8_000,
    }));
    expect(rows.map((row) => row.kind)).toEqual(["group"]);
  });

  it("counts one call once when its lifecycle arrived several times", () => {
    const rows = deriveWorkRows(input({
      tools: [
        tool({ id: "1", name: "read", args: { path: "a.ts" }, status: "running", endedAt: undefined }),
        tool({ id: "1", name: "read", args: { path: "a.ts" } }),
        tool({ id: "1", name: "read", args: { path: "a.ts" } }),
      ],
    }));
    expect(rows[0].kind === "fold" ? summaries(rows[0].rows) : []).toEqual(["Read 1 file"]);
  });

  it("has no rows for no tools", () => {
    expect(deriveWorkRows(input({ tools: [] }))).toEqual([]);
  });
});

describe("detail levels", () => {
  const work = [tool({ id: "1", name: "read", args: { path: "a.ts" } }), tool({ id: "2", name: "bash", args: { command: "npm test" } })];

  it("stops folding at detailed and opens the groups", () => {
    const rows = deriveWorkRows(input({ tools: work, detail: "detailed" }));
    expect(rows.map((row) => row.kind)).toEqual(["group"]);
    expect(rows[0]).toMatchObject({ open: true, summary: "Read 1 file and ran 1 command" });
  });

  it("keeps groups closed under focused while the turn runs", () => {
    const rows = deriveWorkRows(input({ tools: [...work, tool({ id: "3", name: "bash", status: "error" })], status: "running" }));
    expect(rows.map((row) => row.kind === "group" && row.open)).toEqual([false, true]);
  });

  it("cycles the levels and validates a stored one", () => {
    expect(nextTranscriptDetail("focused")).toBe("detailed");
    expect(nextTranscriptDetail("detailed")).toBe("everything");
    expect(nextTranscriptDetail("everything")).toBe("focused");
    expect(isTranscriptDetail("detailed")).toBe(true);
    expect(isTranscriptDetail("verbose")).toBe(false);
  });
});

describe("tool cards", () => {
  const cardIdFor = (run: UiToolRun) => run.name === "tau_spawn_thread" ? "agents.spawn" : undefined;

  it("keeps a batch of one card's calls out of the fold", () => {
    const rows = deriveWorkRows(input({
      cardIdFor,
      tools: [
        tool({ id: "1", name: "tau_spawn_thread" }),
        tool({ id: "2", name: "tau_spawn_thread" }),
        tool({ id: "3", name: "read", args: { path: "a.ts" } }),
      ],
    }));
    expect(rows.map((row) => row.kind)).toEqual(["card", "fold"]);
    expect(rows[0]).toMatchObject({ cardId: "agents.spawn" });
    expect(rows[0].kind === "card" ? rows[0].tools.map((entry) => entry.id) : []).toEqual(["1", "2"]);
  });

  it("keeps a card visible while its turn runs", () => {
    const rows = deriveWorkRows(input({
      cardIdFor,
      status: "running",
      streaming: true,
      tools: [tool({ id: "1", name: "tau_spawn_thread" }), tool({ id: "2", name: "read", args: { path: "a.ts" }, status: "running", endedAt: undefined })],
    }));
    expect(rows.map((row) => row.kind)).toEqual(["card", "live"]);
  });
});

describe("the turn's answer", () => {
  const messages = [
    { id: "u1", role: "user", text: "do it", timestamp: 1 },
    { id: "a1", role: "assistant", text: "", timestamp: 2 },
    { id: "a2", role: "assistant", text: "done", timestamp: 3 },
    { id: "u2", role: "user", text: "again", timestamp: 4 },
    { id: "a3", role: "assistant", text: "ok", timestamp: 5 },
  ];

  it("takes the last assistant message with text before the next prompt", () => {
    expect(answerTimestampAfter(messages, "u1")).toBe(3);
    expect(answerTimestampAfter(messages, "u2")).toBe(5);
  });

  it("has no answer when the turn produced none", () => {
    expect(answerTimestampAfter([messages[0], messages[1]], "u1")).toBeUndefined();
  });

  it("reads from the start when the anchor is not loaded", () => {
    expect(answerTimestampAfter(messages, undefined)).toBeUndefined();
  });
});

describe("a call no renderer claimed", () => {
  it("shows what the call was about, not the names of its arguments", () => {
    expect(toolArgumentSummary({ command: "ls -la\n  src", description: "List files", timeout: 5_000 })).toBe("ls -la src");
    expect(toolArgumentSummary({ file_path: "/repo/a.ts", limit: 20 })).toBe("/repo/a.ts");
    expect(toolArgumentSummary({ server: "linear", title: "Fix it" })).toBe("linear");
  });

  it("falls back to the names when no argument is text", () => {
    expect(toolArgumentSummary({ todos: [], merge: true })).toBe("todos · merge");
    expect(toolArgumentSummary({})).toBe("no arguments");
  });
});

describe("why a call failed", () => {
  it("pairs a shell's exit status with the last thing it printed", () => {
    expect(toolFailureReason("Exit code 1\nls: missing: No such file or directory")).toBe("Exit code 1: ls: missing: No such file or directory");
    expect(toolFailureReason("building\nerror TS2304: x\n\nCommand exited with code 2")).toBe("Command exited with code 2: error TS2304: x");
    expect(toolFailureReason("Exit code 127")).toBe("Exit code 127");
  });

  it("takes the first line of any other answer", () => {
    expect(toolFailureReason("The user doesn't want to proceed with this tool use.\nMore.")).toBe("The user doesn't want to proceed with this tool use.");
    expect(toolFailureReason("x".repeat(400))).toHaveLength(240);
    expect(toolFailureReason("  \n ")).toBeUndefined();
    expect(toolFailureReason(undefined)).toBeUndefined();
  });
});
