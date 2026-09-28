// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, WorkbenchActions } from "tau";
import { createKitHarness, ThreadStore, ThreadStoreContext, WorkbenchShellContext } from "../../src/renderer/test-support/kit-harness.js";
import { implementPlan, planKitExtension } from "./desktop.js";

afterEach(cleanup);

const plan = "# Add a login form\n\n1. Form\n2. Tests";
const snapshot = (fields: Partial<HostSnapshot>) => ({
  sessionId: "s1", cwd: "/repo", isStreaming: false, models: [], thinkingLevel: "off", thinkingLevels: [],
  messages: [], activeTools: [], allTools: [], extensionCount: 0, ...fields,
}) as unknown as HostSnapshot;

function actionsFor(overrides: Partial<WorkbenchActions> = {}) {
  return {
    notify: vi.fn(),
    activeThread: () => ({ sessionId: "s1", cwd: "/repo", draftPending: false, mode: "plan", modes: ["plan"] }),
    setMode: vi.fn(async () => true),
    submitPrompt: vi.fn(async () => true),
    ...overrides,
  } as unknown as WorkbenchActions;
}

describe("Plan Kit desktop extension", () => {
  it("switches between build and plan where the runtime offers it", () => {
    const { registry } = createKitHarness();
    registry.activate(planKitExtension);
    const control = registry.getComposerControls().find((entry) => entry.id === "plan.mode")!;
    const actions = actionsFor();
    const { rerender, container } = render(<control.Component snapshot={snapshot({})} actions={actions} />);
    expect(container.textContent).toBe("");
    expect(control.placement).toBe("menu");
    rerender(<control.Component snapshot={snapshot({ modes: ["plan"] })} actions={actions} />);
    expect(screen.getByRole("radio", { name: /Build/u }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: /Plan/u }));
    expect(actions.setMode).toHaveBeenCalledWith("plan");
    rerender(<control.Component snapshot={snapshot({ modes: ["plan"], mode: "plan" })} actions={actions} />);
    fireEvent.click(screen.getByRole("radio", { name: /Build/u }));
    expect(actions.setMode).toHaveBeenLastCalledWith("default");
  });

  it("shows plan mode beside the model while the thread plans, and leaves it from there", () => {
    const { registry } = createKitHarness();
    registry.activate(planKitExtension);
    const chip = registry.getComposerControls().find((entry) => entry.id === "plan.planning")!;
    expect(chip.placement).toBeUndefined();
    const actions = actionsFor();
    const { rerender, container } = render(<chip.Component snapshot={snapshot({ modes: ["plan"] })} actions={actions} />);
    expect(container.textContent).toBe("");
    rerender(<chip.Component snapshot={snapshot({ modes: ["plan"], mode: "plan" })} actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: /Plan mode/u }));
    expect(actions.setMode).toHaveBeenLastCalledWith("default");
  });

  it("draws a proposed plan as a card with its title", () => {
    const { registry } = createKitHarness();
    registry.activate(planKitExtension);
    const block = registry.getMessageBlocks().find((entry) => entry.tag === "proposed_plan")!;
    render(
      <WorkbenchShellContext.Provider value={{ registry, actions: actionsFor() }}>
        <block.Component body={plan} complete message={{ id: "a1", role: "assistant", text: "", timestamp: 0 }} streaming={false} />
      </WorkbenchShellContext.Provider>,
    );
    expect(screen.getByRole("heading", { name: "Add a login form" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Proposed plan: Add a login form" }).textContent).toContain("Form");
  });

  it("offers Implement once a plan-mode turn settles on a plan, and sends it in build mode", async () => {
    const { registry } = createKitHarness();
    registry.activate(planKitExtension);
    const region = registry.getRegions("composer-above").find((entry) => entry.id === "plan.follow-up")!;
    const actions = actionsFor();
    const messages = [
      { id: "u1", role: "user", text: "plan it", timestamp: 0 },
      { id: "a1", role: "assistant", text: `Here.\n\n<proposed_plan>\n${plan}\n</proposed_plan>`, timestamp: 1 },
    ];
    const view = render(
      <ThreadStoreContext.Provider value={new ThreadStore()}>
        <region.Component snapshot={snapshot({ messages, mode: "plan", modes: ["plan"], isStreaming: true } as never)} actions={actions} />
      </ThreadStoreContext.Provider>,
    );
    expect(view.container.textContent).toBe("");
    view.rerender(
      <ThreadStoreContext.Provider value={new ThreadStore()}>
        <region.Component snapshot={snapshot({ messages, mode: "plan", modes: ["plan"] } as never)} actions={actions} />
      </ThreadStoreContext.Provider>,
    );
    expect(screen.getByRole("region", { name: "Plan ready" }).textContent).toContain("Add a login form");
    fireEvent.click(screen.getByRole("button", { name: "Implement" }));
    await vi.waitFor(() => expect(actions.submitPrompt).toHaveBeenCalledWith(`PLEASE IMPLEMENT THIS PLAN:\n${plan}`));
    expect(actions.setMode).toHaveBeenCalledWith("default");
  });

  it("does not send the plan when the thread stays in plan mode", async () => {
    const actions = actionsFor({ setMode: vi.fn(async () => false) });
    await implementPlan(actions, plan);
    expect(actions.submitPrompt).not.toHaveBeenCalled();
  });
});
