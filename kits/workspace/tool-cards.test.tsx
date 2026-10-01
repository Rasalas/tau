// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiToolRun } from "tau";
import { editLines, presentRead, presentWrite } from "./tool-cards.js";

afterEach(cleanup);

const call = (name: string, args: Record<string, unknown>, partial: Partial<UiToolRun> = {}): UiToolRun =>
  ({ id: "t", name, args, status: "done", startedAt: 0, endedAt: 1, ...partial });

describe("an edit's diff", () => {
  it("shows only the lines a replacement changes, from Pi's edits[]", () => {
    const edit = call("edit", { path: "a.ts", edits: [{ oldText: "const a = 1;\nconst hits = new Map();\nexport {};", newText: "const a = 1;\nconst hits = redis.multi();\nawait hits.exec();\nexport {};" }] });
    expect(editLines(edit)).toEqual([
      { sign: "-", text: "const hits = new Map();" },
      { sign: "+", text: "const hits = redis.multi();" },
      { sign: "+", text: "await hits.exec();" },
    ]);
  });

  it("reads the Agent SDK's old_string/new_string, a MultiEdit and a write", () => {
    expect(editLines(call("Edit", { file_path: "a.ts", old_string: "a", new_string: "b" }))).toEqual([{ sign: "-", text: "a" }, { sign: "+", text: "b" }]);
    expect(editLines(call("MultiEdit", { file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] }))).toHaveLength(2);
    expect(editLines(call("write", { path: "n.ts", content: "one\ntwo\n" }))).toEqual([{ sign: "+", text: "one" }, { sign: "+", text: "two" }]);
  });

  it("falls back to the +/- lines of a patch the runtime printed", () => {
    const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n context";
    expect(editLines(call("edit", { path: "a.ts" }, { output: patch }))).toEqual([{ sign: "-", text: "old" }, { sign: "+", text: "new" }]);
    expect(editLines(call("edit", { path: "a.ts" }, { output: "Edited a.ts" }))).toBeUndefined();
  });

  it("draws the card's head and the diff under it, and none for an edit that failed", () => {
    const view = presentWrite(call("edit", { path: "src/limiter.ts", edits: [{ oldText: "a\nb", newText: "c" }] }));
    expect(view).toMatchObject({ title: "Edit", detail: "src/limiter.ts", file: "src/limiter.ts", tone: "write" });
    const drawn = render(<>{view.note}{view.body}</>);
    expect(drawn.container.querySelector(".tool-diff-stat")?.textContent).toBe("+1 −2");
    expect([...drawn.container.querySelectorAll(".tool-diff > div")].map((line) => line.className)).toEqual(["del", "del", "add"]);
    expect(presentWrite(call("edit", { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, { status: "error" })).body).toBeUndefined();
  });

  it("says how many more lines a long diff has", () => {
    const content = Array.from({ length: 45 }, (_, index) => `line ${index}`).join("\n");
    const drawn = render(<>{presentWrite(call("write", { path: "big.ts", content })).body}</>);
    expect(drawn.container.querySelector(".tool-diff > .more")?.textContent).toBe("… 5 more lines");
  });
});

describe("a read", () => {
  it("names the file for any runtime's read, and keeps other lookups by their own name", () => {
    expect(presentRead(call("Read", { file_path: "/repo/a.ts" }))).toMatchObject({ title: "Read", detail: "/repo/a.ts", file: "/repo/a.ts" });
    expect(presentRead(call("grep", { pattern: "TODO" }))).toMatchObject({ title: "grep", detail: "TODO" });
  });
});
