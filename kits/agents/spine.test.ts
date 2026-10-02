import { describe, expect, it } from "vitest";
import type { ToolPresentation, UiToolRun } from "tau";
import { spineSteps } from "./spine.js";

const tool = (id: string, name: string, args: Record<string, unknown>, status: UiToolRun["status"] = "done"): UiToolRun => ({ id, name, args, status, startedAt: 0 });

function present(run: UiToolRun): ToolPresentation {
  if (run.name === "read") return { glyph: "→", title: "read", tone: "read", detail: String(run.args.path), file: String(run.args.path) };
  if (run.name === "edit") return { glyph: "±", title: "edit", tone: "write", detail: String(run.args.path), file: String(run.args.path) };
  if (run.name === "bash") return { glyph: "$", title: "bash", tone: "shell", detail: String(run.args.command) };
  return { glyph: "◇", title: run.name, tone: "neutral", detail: "" };
}

describe("the spine's steps", () => {
  it("joins a run of one kind into one step and names the running one in the present", () => {
    const steps = spineSteps([
      tool("1", "read", { path: "src/a.ts" }),
      tool("2", "read", { path: "src/b.ts" }),
      tool("3", "edit", { path: "src/watcher.ts" }),
      tool("4", "web_search", {}),
      tool("5", "bash", { command: "vitest run pairing --repeat 20" }, "running"),
    ], present);
    expect(steps).toEqual([
      { label: "Read 2 files", running: false },
      { label: "Edited watcher.ts", running: false },
      { label: "web_search", running: false },
      { label: "Running vitest", running: true },
    ]);
  });
});
