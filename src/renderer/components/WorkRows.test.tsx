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

  it("reads as one line and gives the work back where it sat", () => {
    render(<WorkGroup id="turn" tools={tools} registry={registryWith()} detail="focused" />);

    expect(screen.getByRole("button", { name: /Worked for/u })).toBeTruthy();
    expect(screen.queryByText("Read 2 files and ran 1 command")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Worked for/u }));
    expect(screen.getByText("Read 2 files and ran 1 command")).toBeTruthy();
    expect(screen.getByText("a.ts")).toBeTruthy();
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
    expect(screen.getByRole("img", { name: "Failed: Exit code 1: npm error Missing script: broken" })).toBeTruthy();
    expect(screen.getByText("Exit code 1: npm error Missing script: broken")).toBeTruthy();
  });

  it("opens every group and shows the calls at detailed", () => {
    render(<WorkGroup id="turn" tools={tools} registry={registryWith()} detail="detailed" />);
    expect(screen.queryByRole("button", { name: /Worked for/u })).toBeNull();
    expect(screen.getByText("a.ts")).toBeTruthy();
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
    expect(screen.getByText("Ran 1 command")).toBeTruthy();
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
