// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiToolRun } from "../../shared/contracts";
import { ExtensionRegistry, type DesktopExtension } from "../extension-system";
import { ToolRun } from "./ToolRun";

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
      () => ({ glyph: "◉", title: "Window state", tone: "read", detail: "desktop", output: "hidden" }),
    );
  },
};

function registryWithBundledExtensions(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  registry.activate(presentationStub);
  return registry;
}

const command = (partial: Partial<UiToolRun> = {}): UiToolRun => ({
  id: "bash",
  name: "bash",
  args: { command: "verbose" },
  status: "done",
  startedAt: 0,
  endedAt: 10,
  ...partial,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("tool run output", () => {
  it("does not print the structured output of a tool whose renderer hides it", () => {
    render(<ToolRun
      tool={{
        id: "computer-use",
        name: "computer_use_get_window_state",
        args: { pid: 42, window_id: 7 },
        output: '{"elements":[{"role":"button","label":"Save"}]}',
        status: "running",
        startedAt: Date.now(),
      }}
      registry={registryWithBundledExtensions()}
    />);

    expect(screen.queryByText(/"elements"/)).toBeNull();
    expect(screen.getByText("Window state")).toBeTruthy();
  });

  it("shows the live tail of a running tool without a click", () => {
    const view = render(<ToolRun
      tool={command({ status: "running", endedAt: undefined, output: "one\ntwo\nthree\nfour\nfive\nsix" })}
      registry={registryWithBundledExtensions()}
    />);

    expect(view.container.querySelector(".tool-output")?.textContent).toContain("two\nthree\nfour\nfive\nsix");
    expect(view.container.querySelector(".tool-output")?.textContent).not.toContain("one\ntwo");
  });

  it("keeps settled output behind a click on the row", () => {
    const output = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
    const view = render(<ToolRun tool={command({ output })} registry={registryWithBundledExtensions()} />);

    expect(view.container.querySelector(".tool-output")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    expect(view.container.querySelector(".tool-output")?.textContent).toContain("line 39");
  });

  it("delegates clipped output to the deliberate full-output reader", async () => {
    const readFullOutput = vi.fn().mockResolvedValue(undefined);
    const output = Array.from({ length: 40 }, (_, index) => `line ${index} ${"x".repeat(1_024)}`).join("\n");
    render(<ToolRun tool={command({ output })} registry={registryWithBundledExtensions()} onCopyOutput={readFullOutput} />);

    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    fireEvent.click(screen.getByRole("button", { name: /copy full output/u }));
    await act(async () => undefined);
    expect(readFullOutput).toHaveBeenCalledWith(expect.objectContaining({ id: "bash" }));
  });

  it("shows the full-output action for a bridge preview clipped below the renderer limit", () => {
    const readFullOutput = vi.fn();
    render(<ToolRun
      tool={command({ output: "preview tail", outputTruncated: true, fullOutputAvailable: true })}
      registry={registryWithBundledExtensions()}
      onCopyOutput={readFullOutput}
    />);

    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    expect(screen.getByRole("button", { name: /copy full output/u })).toBeTruthy();
    expect(readFullOutput).not.toHaveBeenCalled();
  });

  it("prints the whole result and stamps the call at everything", () => {
    const output = Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(64)}`).join("\n");
    const view = render(<ToolRun tool={command({ output })} registry={registryWithBundledExtensions()} detail="everything" />);

    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    expect(view.container.querySelector(".tool-output")?.textContent).toContain("line 0 ");
    expect(view.container.querySelector(".tool-output")?.textContent).toContain("line 399 ");
    expect(view.container.querySelector(".tool-output-truncated")).toBeNull();
    expect(view.container.querySelector("time.tool-run-stamp")).toBeTruthy();
  });

  it("keeps waiting and interrupted states distinct", () => {
    const registry = registryWithBundledExtensions();
    const { rerender } = render(<ToolRun
      tool={command({ id: "waiting", status: "running", endedAt: undefined })}
      registry={registry}
      waiting
    />);
    expect(screen.getByText("waiting for you")).toBeTruthy();

    rerender(<ToolRun tool={command({ id: "waiting", status: "running", endedAt: undefined })} registry={registry} stalled />);
    expect(screen.getByText("interrupted")).toBeTruthy();
  });

  it("offers one way out of a call that is still open", () => {
    const onStop = vi.fn();
    render(<ToolRun tool={command({ status: "running", endedAt: undefined })} registry={registryWithBundledExtensions()} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop the run" }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});
