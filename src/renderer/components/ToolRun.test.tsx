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

  it("names a deferred output's size and loads it when the row opens, once", async () => {
    const output = Array.from({ length: 400 }, (_, index) => `line ${index} ${"x".repeat(64)}`).join("\n");
    let resolve!: (value: { toolCallId: string; output: string }) => void;
    const load = vi.fn(() => new Promise<{ toolCallId: string; output: string }>((done) => { resolve = done; }));
    const tool = command({ outputDeferred: true, outputLength: 28_000 });
    const view = render(<ToolRun tool={tool} registry={registryWithBundledExtensions()} onLoadOutput={load} />);

    expect(screen.getByText("27 KB")).toBeTruthy();
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    const pending = view.container.querySelector(".tool-output-pending");
    expect(pending?.textContent).toBe("Loading 27 KB output…");
    await act(async () => resolve({ toolCallId: "bash", output }));
    expect(view.container.querySelector(".tool-output-pending")).toBeNull();
    expect(view.container.querySelector(".tool-output")?.textContent).toContain("line 399 ");

    // Closed and opened again, or handed a new object for the same tool: no second load.
    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    view.rerender(<ToolRun tool={{ ...tool }} registry={registryWithBundledExtensions()} onLoadOutput={load} />);
    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    expect(view.container.querySelector(".tool-output")?.textContent).toContain("line 399 ");
    expect(load).toHaveBeenCalledOnce();
  });

  it("says so when a deferred output cannot be loaded, and tries again on the next opening", async () => {
    const load = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ toolCallId: "bash", output: "found it" });
    const view = render(<ToolRun tool={command({ outputDeferred: true, outputLength: 20_000 })} registry={registryWithBundledExtensions()} onLoadOutput={load} />);
    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    await act(async () => undefined);
    expect(view.container.querySelector(".tool-output-pending")?.textContent).toBe("The output could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    fireEvent.click(screen.getByRole("button", { name: /verbose/u }));
    await act(async () => undefined);
    expect(view.container.querySelector(".tool-output")?.textContent).toContain("found it");
  });

  it("shows a failed command's output with its exit status and time, and its reason once closed (design 1f)", () => {
    const view = render(<ToolRun
      tool={command({ args: { command: "ls missing" }, status: "error", output: "Exit code 1\nls: missing: No such file or directory", startedAt: 0, endedAt: 2_300 })}
      registry={registryWithBundledExtensions()}
    />);
    const reason = "Exit code 1: ls: missing: No such file or directory";
    expect(screen.getByRole("img", { name: `Failed: ${reason}` }).textContent).toBe("exit 1 · 2.3s");
    expect(view.container.querySelector(".tool-run.failed > .tool-output")?.textContent).toContain("No such file or directory");
    expect(screen.queryByText(reason)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /ls missing/u }));
    expect(view.container.querySelector(".tool-output")).toBeNull();
    expect(screen.getByText(reason)).toBeTruthy();
  });

  it("draws what a kit puts at the row's end and under it instead of the output", () => {
    const registry = new ExtensionRegistry();
    registry.activate({ id: "acme.edits", name: "Edits", activate(context) {
      context.registerToolRenderer("acme.edit", (tool) => tool.name === "edit", () => ({ glyph: "±", title: "Edit", tone: "write", detail: "a.ts", note: <b>+1 −1</b>, body: <pre>- a{"\n"}+ b</pre> }));
    } });
    const view = render(<ToolRun tool={{ id: "e", name: "edit", args: {}, status: "done", output: "Replaced 1 block.", startedAt: 0, endedAt: 400 }} registry={registry} />);
    expect(screen.getByText("+1 −1")).toBeTruthy();
    expect(view.container.querySelector("pre")?.textContent).toBe("- a\n+ b");
    fireEvent.click(screen.getByRole("button", { name: /Edit/u }));
    expect(screen.queryByText("Replaced 1 block.")).toBeNull();
    expect(screen.getByText("0.4s")).toBeTruthy();
  });

  it("names the command of a call no renderer claimed, not its arguments", () => {
    render(<ToolRun
      tool={{ id: "t", name: "Shell", args: { command: "npm test", description: "Run the tests", timeout: 60_000 }, status: "done", startedAt: 0, endedAt: 10 }}
      registry={new ExtensionRegistry()}
    />);
    expect(screen.getByText("npm test")).toBeTruthy();
    expect(screen.queryByText(/description/u)).toBeNull();
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
