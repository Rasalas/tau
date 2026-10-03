// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiToolRun } from "../../shared/contracts";
import { ExtensionRegistry, type DesktopExtension, type WorkbenchActions } from "../extension-system";
import { WorkGroup, type WorkGroupProps } from "./WorkRows";
import { WorkDisclosures } from "./work-disclosures";

/** Stands in for whichever kit names the file and shell tools. */
const toolPresentation: DesktopExtension = {
  id: "test.tools",
  name: "Tools",
  activate(context) {
    context.registerToolRenderer(
      "test.read",
      (tool) => ["read", "grep", "find", "ls"].includes(tool.name),
      (tool) => ({ glyph: "→", title: tool.name, tone: "read", detail: String(tool.args.path ?? tool.args.pattern ?? "workspace") }),
    );
    context.registerToolRenderer(
      "test.shell",
      (tool) => tool.name === "bash",
      (tool) => ({ glyph: "$", title: tool.name, tone: "shell", detail: String(tool.args.command ?? "shell command") }),
    );
  },
};

const registryWith = (...extensions: DesktopExtension[]) => {
  const registry = new ExtensionRegistry();
  for (const extension of [toolPresentation, ...extensions]) registry.activate(extension);
  return registry;
};

const read = (id: string, path: string, partial: Partial<UiToolRun> = {}): UiToolRun =>
  ({ id, name: "read", args: { path }, status: "done", startedAt: 1_000, endedAt: 2_000, ...partial });
const run = (id: string, command: string, partial: Partial<UiToolRun> = {}): UiToolRun =>
  ({ id, name: "bash", args: { command }, status: "done", startedAt: 1_000, endedAt: 2_000, ...partial });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a settled turn", () => {
  const tools = [read("1", "a.ts"), read("2", "b.ts"), run("3", "npm test")];

  it("reads as one line and gives the calls back as one card, one fold level deep (design 1f)", () => {
    render(<WorkGroup id="turn" tools={tools} registry={registryWith()} detail="focused" />);

    expect(screen.getByRole("button", { name: /Worked for/u })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Read 2 files and ran 1 command" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Worked for/u }));
    expect(screen.getByRole("group", { name: "Read 2 files and ran 1 command" })).toBeTruthy();
    expect(screen.getByText("npm test")).toBeTruthy();
  });

  it("bundles files read one after another into one row that opens to each", () => {
    render(<WorkGroup id="turn" tools={[read("1", "src/a.ts"), read("2", "src/b.ts"), run("3", "npm test"), read("4", "c.ts")]} registry={registryWith()} detail="detailed" />);
    const bundle = screen.getByRole("button", { name: /a\.ts, b\.ts/u });
    expect(bundle.textContent).toContain("2 files");
    expect(screen.getByText("c.ts")).toBeTruthy();
    expect(screen.queryByText("src/a.ts")).toBeNull();

    fireEvent.click(bundle);
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
  });

  it("says it was stopped when the turn was interrupted", () => {
    render(<WorkGroup id="turn" tools={tools} registry={registryWith()} detail="focused" status="interrupted" />);
    expect(screen.getByRole("button", { name: /Stopped after/u })).toBeTruthy();
  });

  it("folds a failure with the rest and shows it, with its reason, when opened", () => {
    render(<WorkGroup
      id="turn"
      tools={[...tools, run("4", "npm run broken", { status: "error", output: "Exit code 1\nnpm error Missing script: broken" })]}
      registry={registryWith()}
      detail="focused"
    />);

    expect(screen.queryByText("npm run broken")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Worked for/u }));
    expect(screen.getByText("npm run broken")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Failed: Exit code 1: npm error Missing script: broken" }).textContent).toBe("exit 1 · 1.0s");
    expect(screen.getByText(/npm error Missing script: broken/u).closest(".tool-output")).toBeTruthy();
  });

  it("shows the calls without a fold at detailed", () => {
    render(<WorkGroup id="turn" tools={tools} registry={registryWith()} detail="detailed" />);
    expect(screen.queryByRole("button", { name: /Worked for/u })).toBeNull();
    expect(screen.getByText("npm test")).toBeTruthy();
  });
});

describe("a running turn", () => {
  it("shows one line that morphs in place instead of a growing log", () => {
    const registry = registryWith();
    const view = render(<WorkGroup
      id="turn"
      tools={[read("1", "a.ts"), read("2", "b.ts", { status: "running", endedAt: undefined })]}
      registry={registry}
      detail="focused"
      status="running"
      streaming
    />);
    const line = view.container.querySelector(".work-live");
    expect(screen.getByText("Reading b.ts")).toBeTruthy();
    // As T3 Code: the tool's glyph and a shining label, no spinner.
    expect(line?.classList.contains("running")).toBe(true);
    expect(line?.querySelector(".spinner")).toBeNull();

    view.rerender(<WorkGroup
      id="turn"
      tools={[read("1", "a.ts"), read("2", "b.ts"), run("3", "npm test", { status: "running", endedAt: undefined })]}
      registry={registry}
      detail="focused"
      status="running"
      streaming
    />);
    expect(screen.getByText("Running npm")).toBeTruthy();
    expect(view.container.querySelector(".work-live")).toBe(line);
  });

  it("keeps completed calls collapsed after commentary during a focused turn", () => {
    const disclosures = new WorkDisclosures();
    const props = { id: "turn", tools: [run("rg", "rg -n verbosity src")], registry: registryWith(), detail: "focused" as const, status: "running" as const, streaming: false, disclosures };
    const view = render(<WorkGroup {...props} />);
    expect(screen.queryByText("rg -n verbosity src")).toBeNull();
    const summary = screen.getByRole("button", { name: "Ran 1 command" });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(screen.getByText("rg -n verbosity src")).toBeTruthy();
    view.unmount();
    render(<WorkGroup {...props} />);
    expect(screen.getByText("rg -n verbosity src")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ran 1 command" }));
    expect(screen.queryByText("rg -n verbosity src")).toBeNull();
  });

  it("keeps execution code behind the live disclosure", () => {
    const code = 'text(await tools.exec_command({cmd: "rg -n verbosity src"}));';
    render(<WorkGroup id="turn" tools={[{ id: "exec", name: "exec", args: { code }, status: "running", startedAt: Date.now() }]} registry={registryWith()} detail="focused" status="running" streaming />);
    expect(screen.queryByText(code)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Using exec/u }));
    expect(screen.getByText(code)).toBeTruthy();
  });

  it("counts up without a React commit per tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const view = render(<WorkGroup
      id="turn"
      tools={[read("1", "a.ts", { status: "running", startedAt: 53_000, endedAt: undefined })]}
      registry={registryWith()}
      detail="focused"
      status="running"
      streaming
    />);

    expect(view.container.querySelector(".work-live-clock")?.textContent).toBe("0:47");
    act(() => vi.advanceTimersByTime(3_000));
    expect(view.container.querySelector(".work-live-clock")?.textContent).toBe("0:50");
  });

  it("drops a failing tool out of the live line", () => {
    render(<WorkGroup
      id="turn"
      tools={[run("1", "npm run broken", { status: "error" }), read("2", "b.ts", { status: "running", endedAt: undefined })]}
      registry={registryWith()}
      detail="focused"
      status="running"
      streaming
    />);

    expect(screen.getByText("Reading b.ts")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Ran 1 command" })).toBeTruthy();
    expect(screen.getByText("npm run broken")).toBeTruthy();
  });

  it("says it is waiting when the tool holds an open question", () => {
    render(<WorkGroup
      id="turn"
      tools={[read("1", "a.ts", { status: "running", endedAt: undefined })]}
      registry={registryWith()}
      detail="focused"
      status="running"
      streaming
      waiting
    />);
    expect(screen.getByText("Waiting for your answer")).toBeTruthy();
    // As the design draws it: a quiet spinner and what is asked, no clock.
    expect(document.querySelector(".work-live.waiting .work-live-line > .spinner")).toBeTruthy();
    expect(document.querySelector(".work-live-clock")).toBeNull();
  });

  it("names what an approval waits to do", () => {
    const { rerender } = render(<WorkGroup
      id="turn"
      tools={[{ id: "w", name: "write", args: { path: "src/a.ts", content: "x" }, status: "running", startedAt: 1_000 }]}
      registry={registryWith()}
      detail="focused"
      status="running"
      streaming
      waiting
      waitingFor="approval"
    />);
    expect(screen.getByText("Waiting for permission to edit")).toBeTruthy();
    rerender(<WorkGroup
      id="turn"
      tools={[run("b", "rm -rf build", { status: "running", endedAt: undefined })]}
      registry={registryWith()}
      detail="focused"
      status="running"
      streaming
      waiting
      waitingFor="approval"
    />);
    expect(screen.getByText("Waiting for permission to run a command")).toBeTruthy();
  });

  it("reports a turn whose runtime is gone as stopped", () => {
    render(<WorkGroup
      id="turn"
      tools={[read("1", "a.ts", { status: "running", endedAt: undefined })]}
      registry={registryWith()}
      detail="focused"
      status="running"
      streaming={false}
    />);
    expect(screen.getByRole("button", { name: /Stopped after/u })).toBeTruthy();
  });
});

describe("a tool card", () => {
  const spawnCard: DesktopExtension = {
    id: "test.agents",
    name: "Agents",
    activate(context) {
      context.registerToolCard({
        id: "test.spawn",
        match: (tool) => tool.name === "tau_spawn_thread",
        Component: ({ tools, actions }) => (
          <button type="button" onClick={() => actions.openPanel("agents")}>Started {tools.length} agents</button>
        ),
      });
    },
  };
  const spawn = (id: string): UiToolRun =>
    ({ id, name: "tau_spawn_thread", args: {}, status: "done", startedAt: 1_000, endedAt: 2_000 });

  it("draws one card for the batch and leaves it out of the fold", () => {
    const openPanel = vi.fn();
    render(<WorkGroup
      id="turn"
      tools={[spawn("1"), spawn("2"), read("3", "a.ts")]}
      registry={registryWith(spawnCard)}
      actions={{ openPanel } as unknown as WorkbenchActions}
      detail="focused"
    />);

    expect(screen.getByText("Started 2 agents")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Worked for/u })).toBeTruthy();
    fireEvent.click(screen.getByText("Started 2 agents"));
    expect(openPanel).toHaveBeenCalledWith("agents");
  });

  it("draws nothing for a card whose extension went away", () => {
    const view = render(<WorkGroup
      id="turn"
      tools={[spawn("1")]}
      registry={registryWith()}
      detail="focused"
    />);
    expect(view.container.textContent).toContain("Worked for");
  });
});

describe("when the turn ends", () => {
  const registry = registryWith();
  const running = [read("1", "a.ts"), run("2", "npm test", { status: "running", endedAt: undefined })];
  const settled = [read("1", "a.ts"), run("2", "npm test")];
  const turn = (props: Partial<WorkGroupProps>) => <WorkGroup id="turn" tools={settled} registry={registry} detail="focused" {...props} />;

  it("folds what ran into one line", () => {
    const view = render(turn({ tools: running, status: "running", streaming: true }));
    expect(screen.getByText("Running npm")).toBeTruthy();

    view.rerender(turn({ status: "completed", streaming: false }));
    expect(screen.getByRole("button", { name: /Worked for/u }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("npm test")).toBeNull();
  });

  it("leaves open what the reader opened while it ran, until they close it", () => {
    const disclosures = new WorkDisclosures();
    const view = render(turn({ tools: running, status: "running", streaming: true, disclosures }));
    fireEvent.click(screen.getByRole("button", { name: /Running npm/u }));

    view.rerender(turn({ status: "completed", streaming: false, disclosures }));
    const fold = screen.getByRole("button", { name: /Worked for/u });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("npm test")).toBeTruthy();

    fireEvent.click(fold);
    view.unmount();
    render(turn({ status: "completed", streaming: false, disclosures }));
    expect(screen.getByRole("button", { name: /Worked for/u }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps it open when the settled turn moves into the history under another id", () => {
    const disclosures = new WorkDisclosures();
    const view = render(turn({ id: "turn-activity:1", tools: running, status: "running", streaming: true, disclosures }));
    fireEvent.click(screen.getByRole("button", { name: /Running npm/u }));
    view.unmount();

    render(turn({ id: "activity-7", disclosures }));
    expect(screen.getByRole("button", { name: /Worked for/u }).getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps a fold the reader opened open when the list remounts it", () => {
    const disclosures = new WorkDisclosures();
    const view = render(turn({ disclosures }));
    fireEvent.click(screen.getByRole("button", { name: /Worked for/u }));
    view.unmount();

    render(turn({ disclosures }));
    expect(screen.getByRole("button", { name: /Worked for/u }).getAttribute("aria-expanded")).toBe("true");
  });

  it("folds the next turn however the reader left the last one", () => {
    const disclosures = new WorkDisclosures();
    const view = render(turn({ id: "turn-a", tools: running, status: "running", streaming: true, disclosures }));
    fireEvent.click(screen.getByRole("button", { name: /Running npm/u }));

    view.rerender(turn({ id: "turn-b", tools: [run("3", "ls")], disclosures }));
    expect(screen.getByRole("button", { name: /Worked for/u }).getAttribute("aria-expanded")).toBe("false");
  });
});
