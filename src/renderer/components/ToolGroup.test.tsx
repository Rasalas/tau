// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiToolRun } from "../../shared/contracts";
import { ExtensionRegistry, type DesktopExtension } from "../extension-system";
import { bundledExtensions } from "../extensions";
import { TOOL_PREVIEW_MIN_MS, ToolGroup } from "./ToolGroup";

/**
 * Shell runs and hidden tool output are extension presentations, and the kits
 * that ship them live outside `src/`. This stub registers the same two
 * contributions, so these tests keep exercising core's own rendering of them.
 */
const presentationStub: DesktopExtension = {
  id: "test.presentation",
  name: "Presentation stub",
  activate(plugin) {
    plugin.registerToolRenderer(
      "stub.shell",
      (tool) => tool.name === "bash" || tool.name === "powershell",
      (tool) => ({ glyph: "$", title: tool.name, tone: "shell", detail: String(tool.args.command ?? "shell command") }),
    );
    plugin.registerToolRenderer(
      "stub.hidden-output",
      (tool) => tool.name.startsWith("computer_use_"),
      () => ({ glyph: "\u25c9", title: "Window state", tone: "read", detail: "desktop", output: "hidden" }),
    );
  },
};

/**
 * Stands in for whichever kit names the file tools; the group only cares that
 * a renderer answered, not which package it came from.
 */
const fileTools: DesktopExtension = {
  id: "test.file-tools",
  name: "File tools",
  activate(context) {
    context.registerToolRenderer(
      "test.read",
      (tool) => ["read", "grep", "find", "ls"].includes(tool.name),
      (tool) => ({ glyph: "→", title: tool.name, tone: "read", detail: String(tool.args.path ?? tool.args.pattern ?? tool.args.query ?? "workspace") }),
    );
    context.registerToolRenderer(
      "test.write",
      (tool) => tool.name === "edit" || tool.name === "write",
      (tool) => ({ glyph: "±", title: tool.name, tone: "write", detail: String(tool.args.path ?? "file mutation") }),
    );
  },
};

function registryWithBundledExtensions(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  for (const extension of [...bundledExtensions, presentationStub, fileTools]) registry.activate(extension);
  return registry;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ToolGroup output presentation", () => {
  it("does not print the structured output of a tool whose renderer hides it", () => {
    const tool: UiToolRun = {
      id: "computer-use",
      name: "computer_use_get_window_state",
      args: { pid: 42, window_id: 7 },
      output: '{"elements":[{"role":"button","label":"Save"}]}',
      status: "running",
      startedAt: Date.now(),
    };

    render(<ToolGroup tools={[tool]} registry={registryWithBundledExtensions()} />);

    expect(screen.queryByText(/"elements"/)).toBeNull();
    expect(screen.getByText("Window state")).toBeTruthy();
  });

  it("shows only the newest running tool and its live output tail", () => {
    const tools: UiToolRun[] = [
      { id: "done", name: "read", args: { path: "old.ts" }, status: "done", startedAt: 0, endedAt: 1 },
      { id: "first-live", name: "read", args: { path: "first.ts" }, output: "first output", status: "running", startedAt: Date.now() },
      { id: "current", name: "bash", args: { command: "npm test" }, output: "one\ntwo\nthree\nfour\nfive\nsix", status: "running", startedAt: Date.now() },
    ];

    const view = render(<ToolGroup tools={tools} registry={registryWithBundledExtensions()} />);

    expect(screen.getByText("npm test")).toBeTruthy();
    expect(view.container.querySelector(".tool-output")?.textContent).toContain("two\nthree\nfour\nfive\nsix");
    expect(screen.queryByText("old.ts")).toBeNull();
    expect(screen.queryByText("first.ts")).toBeNull();
    expect(screen.queryByText("one\ntwo\nthree\nfour\nfive\nsix")).toBeNull();
  });

  it("keeps each live tool visible for three seconds before replacing it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const first: UiToolRun = { id: "first", name: "read", args: { path: "first.ts" }, status: "running", startedAt: Date.now() };
    const second: UiToolRun = { id: "second", name: "read", args: { path: "second.ts" }, status: "running", startedAt: Date.now() };
    const view = render(<ToolGroup tools={[first]} registry={registryWithBundledExtensions()} streaming />);

    view.rerender(<ToolGroup
      tools={[{ ...first, status: "done", endedAt: Date.now() }, second]}
      registry={registryWithBundledExtensions()}
      streaming
    />);
    expect(screen.getByText("first.ts")).toBeTruthy();
    expect(screen.queryByText("second.ts")).toBeNull();

    act(() => vi.advanceTimersByTime(2_999));
    expect(screen.getByText("first.ts")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("second.ts")).toBeTruthy();
  });

  it("keeps the working state visible between tool calls", () => {
    const settled: UiToolRun = { id: "read", name: "read", args: { path: "README.md" }, status: "done", startedAt: 0, endedAt: 10 };
    render(<ToolGroup tools={[settled]} registry={registryWithBundledExtensions()} streaming />);

    expect(screen.getByText(/Working/u)).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(document.querySelector(".tool-activity-summary .spinner")).toBeTruthy();
  });

  it("does not auto-collapse live activity while the turn is still streaming", () => {
    vi.useFakeTimers();
    const settled: UiToolRun = { id: "read", name: "read", args: { path: "README.md" }, status: "done", startedAt: 0, endedAt: 10 };
    render(<ToolGroup tools={[settled]} registry={registryWithBundledExtensions()} streaming />);

    act(() => vi.advanceTimersByTime(TOOL_PREVIEW_MIN_MS + 1_000));

    expect(screen.getByRole("button", { name: /Working/u }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("summarizes settled tools and commands behind one expandable row", () => {
    const tools: UiToolRun[] = [
      { id: "read", name: "read", args: { path: "README.md" }, status: "done", startedAt: 0, endedAt: 10 },
      { id: "bash-1", name: "bash", args: { command: "npm test" }, status: "done", startedAt: 0, endedAt: 10 },
      { id: "bash-2", name: "bash", args: { command: "npm run typecheck" }, status: "done", startedAt: 0, endedAt: 10 },
    ];

    render(<ToolGroup tools={tools} registry={registryWithBundledExtensions()} />);

    expect(screen.getByText("Used 1 tool and ran 2 commands")).toBeTruthy();
    expect(screen.queryByText("README.md")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Used 1 tool/ }));
    expect(screen.getByText("README.md")).toBeTruthy();
  });

  it("keeps the full settled output behind an explicit tool-row action", () => {
    const output = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const view = render(<ToolGroup
      tools={[{ id: "bash", name: "bash", args: { command: "verbose" }, status: "done", output, startedAt: 0, endedAt: 10 }]}
      registry={registryWithBundledExtensions()}
      activityStatus="completed"
    />);

    expect(screen.queryByText("Completed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/u }));
    expect(view.container.querySelector(".tool-output")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    expect(view.container.querySelector(".tool-output")?.textContent).toContain("line 0");
    expect(view.container.querySelector(".tool-output")?.textContent).toContain("line 39");
  });

  it("delegates clipped output to the deliberate full-output reader", async () => {
    const tool: UiToolRun = {
      id: "bash",
      name: "bash",
      args: { command: "verbose" },
      status: "done",
      output: "preview tail",
      startedAt: 0,
      endedAt: 10,
    };
    const readFullOutput = vi.fn().mockResolvedValue(undefined);
    const fullOutput = Array.from({ length: 40 }, (_, index) => `line ${index} ${"x".repeat(1_024)}`).join("\n");
    const view = render(<ToolGroup
      tools={[{ ...tool, output: fullOutput }]}
      registry={registryWithBundledExtensions()}
      onCopyOutput={readFullOutput}
    />);

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/u }));
    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    fireEvent.click(screen.getByRole("button", { name: /copy full output/u }));
    await act(async () => undefined);
    expect(readFullOutput).toHaveBeenCalledWith(expect.objectContaining({ id: "bash" }));
    expect(view.container.querySelector(".tool-output")?.textContent).toContain("line 39");
  });

  it("shows the full-output action for a bridge preview clipped below the renderer limit", () => {
    const readFullOutput = vi.fn();
    render(<ToolGroup
      tools={[{
        id: "bridge-call",
        name: "bash",
        args: { command: "verbose" },
        status: "done",
        output: "preview tail",
        outputTruncated: true,
        fullOutputAvailable: true,
        startedAt: 0,
        endedAt: 10,
      }]}
      registry={registryWithBundledExtensions()}
      onCopyOutput={readFullOutput}
    />);

    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/u }));
    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    expect(screen.getByRole("button", { name: /copy full output/u })).toBeTruthy();
    expect(readFullOutput).not.toHaveBeenCalled();
  });

  it("keeps waiting and interrupted states distinct without settled result badges", async () => {
    const registry = registryWithBundledExtensions();
    const { rerender } = render(<ToolGroup
      tools={[{ id: "waiting", name: "read", args: { path: "question.ts" }, status: "running", startedAt: 0 }]}
      registry={registry}
      streaming
      waiting
    />);
    expect(screen.getByText("Waiting for your answer")).toBeTruthy();
    expect(screen.getByText("waiting for you")).toBeTruthy();

    rerender(<ToolGroup
      tools={[{ id: "interrupted", name: "read", args: { path: "stopped.ts" }, status: "running", startedAt: 0 }]}
      registry={registry}
      streaming={false}
      activityStatus="interrupted"
    />);
    expect(screen.queryByText("Interrupted")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Used 1 tool/u }));
    expect(screen.getByText("interrupted")).toBeTruthy();

    rerender(<ToolGroup
      tools={[{ id: "failed", name: "read", args: { path: "failed.ts" }, status: "error", startedAt: 0, endedAt: 1 }]}
      registry={registry}
      activityStatus="error"
    />);
    expect(screen.queryByText("1 failed")).toBeNull();
  });

  it("does not promote one failed tool to an aggregate error without an authoritative status", () => {
    render(<ToolGroup
      tools={[{ id: "failed", name: "read", args: { path: "failed.ts" }, status: "error", startedAt: 0, endedAt: 1 }]}
      registry={registryWithBundledExtensions()}
    />);

    expect(screen.queryByRole("img", { name: "Activity failed" })).toBeNull();
    expect(screen.queryByText(/failed/u)).toBeNull();
  });

  it.each([
    ["error", "Activity failed"],
    ["interrupted", "Activity interrupted"],
  ] as const)("renders an icon-only authoritative %s activity status", (status, label) => {
    render(<ToolGroup
      tools={[{ id: status, name: "read", args: { path: `${status}.ts` }, status: "done", startedAt: 0, endedAt: 1 }]}
      registry={registryWithBundledExtensions()}
      activityStatus={status}
    />);

    expect(screen.getByRole("img", { name: label }).getAttribute("title")).toBe(label);
    expect(screen.queryByText(label)).toBeNull();
  });

  it.each([
    ["error", "Activity failed"],
    ["interrupted", "Activity interrupted"],
  ] as const)("uses authoritative terminal %s status over a stale running tool", (status, label) => {
    const view = render(<ToolGroup
      tools={[{ id: status, name: "read", args: { path: `${status}.ts` }, status: "running", startedAt: 0 }]}
      registry={registryWithBundledExtensions()}
      streaming={false}
      activityStatus={status}
    />);

    expect(view.container.querySelector(".tool-activity-summary")?.textContent).not.toContain("tool call interrupted");
    expect(screen.getByRole("img", { name: label })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Used 1 tool/u }));
    expect(screen.getByText("interrupted")).toBeTruthy();
  });
});
