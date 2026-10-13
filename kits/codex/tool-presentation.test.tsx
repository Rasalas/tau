// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiToolRun } from "tau";
import { ToolRun, createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { codexExtension } from "./desktop.js";
import { toolFor } from "./events.js";
import { isReplTool, presentRepl } from "./tool-presentation.js";

afterEach(cleanup);

const CODE = "const window = await sky.windows.find('Safari');\nawait window.click('Send');";
const call = (name: string, args: Record<string, unknown>, partial: Partial<UiToolRun> = {}): UiToolRun =>
  ({ id: "call1", name, args, status: "done", startedAt: 1_000, endedAt: 2_000, ...partial });

function row(tool: UiToolRun) {
  const { registry } = createKitHarness();
  registry.activate(codexExtension);
  return render(<ToolRun tool={tool} registry={registry} />);
}

describe("the REPL calls Codex makes", () => {
  it("shows the action's title on the row and keeps the code behind it", () => {
    row(call("mcp__cua_repl__js", { title: "Click the Send button", code: CODE }, { output: "clicked" }));
    const line = screen.getByRole("button", { name: /Computer use/u });
    expect(line.textContent).toContain("Click the Send button");
    expect(screen.queryByText(/sky\.windows/u)).toBeNull();
    expect(line.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(line);
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("await window.click('Send');");
    // The body takes the output's place, so it carries the output too.
    expect(screen.getByText("clicked")).toBeTruthy();
  });

  it("keeps the code off a running row", () => {
    row(call("mcp__node_repl__js", { code: "console.log(40 + 2)" }, { status: "running", endedAt: undefined }));
    expect(screen.getByRole("button", { name: /Run JavaScript/u })).toBeTruthy();
    expect(screen.queryByText(/40 \+ 2/u)).toBeNull();
  });

  it("names a call without a title by what it does", () => {
    expect(presentRepl(call("mcp__cua_repl__js", { code: "1" }))).toMatchObject({ title: "Computer use", detail: "" });
    expect(presentRepl(call("cua_repl.js", { code: "1" }))).toMatchObject({ title: "Computer use" });
    expect(presentRepl(call("js", { code: CODE }))).toMatchObject({ title: "Computer use" });
    expect(presentRepl(call("js", { code: "import sky from '@oai/sky';" }))).toMatchObject({ title: "Computer use" });
    expect(presentRepl(call("js", { code: "console.log(1 + 1)" }))).toMatchObject({ title: "Run JavaScript", detail: "" });
    expect(presentRepl(call("mcp__node_repl__js", { code: "console.log(1)" }))).toMatchObject({ title: "Run JavaScript" });
    expect(presentRepl(call("node_repl.js", { title: "  Sum\n the numbers ", code: "1" }))).toMatchObject({ title: "Run JavaScript", detail: "Sum the numbers" });
  });

  it("leaves the default row to an output it cannot show", () => {
    const held = call("js", { code: CODE }, { outputDeferred: true, outputLength: 40_000 });
    expect(presentRepl(held).body).toBeUndefined();
    expect(presentRepl(call("js", { code: CODE }, { output: "ok" })).body).toBeDefined();
  });

  it("claims the names Codex's events give the calls, and nothing else", () => {
    const args = { title: "Open Safari", code: CODE };
    expect(isReplTool(toolFor({ type: "mcpToolCall", id: "m", server: "cua_repl", tool: "js", arguments: args }, 0)!)).toBe(true);
    expect(isReplTool(toolFor({ type: "mcpToolCall", id: "m", server: "node_repl", tool: "js", arguments: args }, 0)!)).toBe(true);
    expect(isReplTool(toolFor({ type: "dynamicToolCall", id: "d", tool: "js", arguments: args }, 0)!)).toBe(true);
    expect(isReplTool(call("js", { query: "x" }))).toBe(false);
    expect(isReplTool(call("mcp__linear__js", args))).toBe(false);
    expect(isReplTool(call("bash", { command: "ls" }))).toBe(false);
  });
});
