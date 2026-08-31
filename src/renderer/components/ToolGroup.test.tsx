// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { UiToolRun } from "../../shared/contracts";
import { ExtensionRegistry } from "../extension-system";
import { bundledExtensions } from "../extensions";
import { ToolGroup } from "./ToolGroup";

function registryWithBundledExtensions(): ExtensionRegistry {
  const registry = new ExtensionRegistry();
  for (const extension of bundledExtensions) registry.activate(extension);
  return registry;
}

afterEach(cleanup);

describe("ToolGroup computer-use presentation", () => {
  it("does not print structured computer-use JSON into the transcript", () => {
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
});
