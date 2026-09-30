import { describe, expect, it } from "vitest";
import { menuRows, paletteRows, paletteScope, readOnlyCommands, readOnlySources, stepRow, type PaletteCommand, type PaletteRow } from "./palette-results";

const command = (id: string, label: string, group = "Runtime", extensionName = "Runtime Controls"): PaletteCommand =>
  ({ id, label, group, extensionId: "core", extensionName, run: () => undefined });

const item = (id: string, label = id) => ({ id, label, run: () => undefined });

const keys = (rows: PaletteRow[]) => rows.map((row) => row.key);

const commands = [
  command("thread.rename", "Rename thread", "Thread", "Thread Rail"),
  command("runtime.model", "Set model…"),
  command("project.open", "Open project…", "Project", "Workspace Kit"),
  command("thread.settle", "Settle thread", "Thread", "Thread Rail"),
];

describe("palette results", () => {
  it("lists the commands under one heading, grouped in their order, and what a source answered before them", () => {
    expect(keys(paletteRows(commands, ""))).toEqual([
      "head:Commands", "command:thread.rename", "command:thread.settle", "command:runtime.model", "command:project.open",
    ]);
    expect(keys(paletteRows(commands.slice(0, 1), "", [{ id: "threads", label: "Threads", items: [item("t1")] }]))).toEqual([
      "head:Threads", "threads:t1", "head:Commands", "command:thread.rename",
    ]);
  });

  it("puts each source's rows under its label, then the commands: label matches, Settings rows, then group matches", () => {
    const rows = paletteRows(commands, "thread", [
      { id: "threads", label: "Threads", items: [item("t1", "Fix the thread rail"), item("t2")] },
      { id: "projects", label: "Projects", items: [item("p1")] },
      { id: "content", label: "Threads", items: [item("t3")] },
    ], undefined, [item("s1")]);
    expect(keys(rows)).toEqual([
      "head:Threads", "threads:t1", "threads:t2", "content:t3",
      "head:Projects", "projects:p1",
      "head:Commands", "command:thread.rename", "command:thread.settle", "settings:s1",
    ]);
    expect(rows[1]).toMatchObject({ kind: "item", source: "Threads" });
    expect(keys(paletteRows(commands, "runtime", [{ id: "threads", label: "Threads", items: [item("t9")] }]))).toEqual([
      "head:Threads", "threads:t9", "head:Commands", "command:runtime.model",
    ]);
  });

  it("caps each source, drops a row a source answered twice and leaves out an empty section", () => {
    const many = Array.from({ length: 12 }, (_, index) => item(`t${index}`));
    const rows = paletteRows([], "x", [{ id: "threads", label: "Threads", items: [item("t0"), ...many] }, { id: "files", label: "Files", items: [] }], 5);
    expect(keys(rows)).toEqual(["head:Threads", "threads:t0", "threads:t1", "threads:t2", "threads:t3", "threads:t4"]);
  });

  it("reads a leading #, / or > as the tab", () => {
    expect(paletteScope("#pair")).toEqual({ scope: "threads", text: "pair" });
    expect(paletteScope("/src")).toEqual({ scope: "files", text: "src" });
    expect(paletteScope(">pin")).toEqual({ scope: "commands", text: "pin" });
    expect(paletteScope("pair #1")).toEqual({ scope: "all", text: "pair #1" });
  });
});

describe("menu rows", () => {
  const rows = [
    { id: "dark", label: "Dark", run: () => undefined },
    { id: "codex", label: "7 models", keywords: ["Codex"], run: () => undefined },
    { id: "light", label: "Light", detail: "follows the day", run: () => undefined },
    { id: "dark", label: "Dark again", run: () => undefined },
  ];

  it("keeps the level's order and drops a repeated id when nothing is typed", () => {
    expect(keys(menuRows(rows, ""))).toEqual(["menu:dark", "menu:codex", "menu:light"]);
  });

  it("matches label, detail and keywords, label starts first", () => {
    expect(keys(menuRows(rows, "codex"))).toEqual(["menu:codex"]);
    expect(keys(menuRows(rows, "day"))).toEqual(["menu:light"]);
    expect(keys(menuRows([{ id: "a", label: "The dark", run: () => undefined }, ...rows], "dark"))).toEqual(["menu:dark", "menu:a"]);
  });

  it("shows a level that searches itself as it answered", () => {
    expect(keys(menuRows(rows, "nothing like it", true))).toEqual(["menu:dark", "menu:codex", "menu:light"]);
  });
});

describe("palette results on a Read-only device", () => {
  const read = (entry: PaletteCommand): PaletteCommand => ({ ...entry, access: "read" });

  it("leaves out a group whose every command writes and keeps the writes of a group that also looks", () => {
    const listed = readOnlyCommands([
      read(command("thread.next", "Next thread", "Thread")),
      command("thread.pin", "Pin thread", "Thread"),
      command("composer.mode", "Choose the access level", "Composer"),
      { ...command("composer.effort", "Choose the reasoning effort", "Composer"), access: "write" },
    ]);
    expect(listed.map((entry) => entry.id)).toEqual(["thread.next", "thread.pin"]);
  });

  it("leaves out a source whose every row writes", () => {
    const sources = readOnlySources([
      { id: "threads", label: "Threads", items: [{ ...item("t1"), access: "read" as const }, item("t2")] },
      { id: "projects", label: "Projects", items: [item("p1"), { ...item("p2"), access: "write" as const }] },
    ]);
    expect(sources.map((source) => source.id)).toEqual(["threads"]);
  });

  it("steps over rows the device may not run, wrapping, and stays put when none is left", () => {
    const usable = (index: number) => index !== 1 && index !== 2;
    expect(stepRow(4, 0, 1, usable)).toBe(3);
    expect(stepRow(4, 3, 1, usable)).toBe(0);
    expect(stepRow(4, 0, -1, usable)).toBe(3);
    expect(stepRow(4, 2, 1, () => false)).toBe(2);
    expect(stepRow(0, -1, 1, () => true)).toBe(-1);
  });
});
