// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, WorkbenchActions } from "tau";
import { createKitHarness, KitShell, setHostClient, ThreadStore, ThreadStoreContext, useAppKeybindings, WorkbenchShellContext } from "../../src/renderer/test-support/kit-harness.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { implementPlan, planKitExtension } from "./desktop.js";

afterEach(() => { cleanup(); setHostClient(undefined); });

/** The window's registry around a chip that reads it for its shortcut hint. */
const shell = (registry: ReturnType<typeof createKitHarness>["registry"]) => function Shell({ children }: { children: ReactNode }) {
  return <KitShell registry={registry}>{children}</KitShell>;
};

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
    const { rerender, container } = render(<chip.Component snapshot={snapshot({ modes: ["plan"] })} actions={actions} />, { wrapper: shell(registry) });
    expect(container.textContent).toBe("");
    rerender(<chip.Component snapshot={snapshot({ modes: ["plan"], mode: "plan" })} actions={actions} />);
    // The tooltip names the chord, so the chip teaches the way to toggle without it.
    expect(screen.getByRole("button", { name: /Plan mode/u }).getAttribute("data-tooltip-shortcut")).toBe(registry.keybindingLabel("plan.toggle"));
    expect(registry.keybindingLabel("plan.toggle")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Plan mode/u }));
    expect(actions.setMode).toHaveBeenLastCalledWith("default");
  });

  it("toggles plan mode with Shift+Tab in the composer's text field and nowhere else", async () => {
    const { registry } = createKitHarness();
    registry.activate(planKitExtension);
    const press = (contexts: string[]) => registry.matchKeybinding(
      new KeyboardEvent("keydown", { key: "Tab", code: "Tab", shiftKey: true }),
      (name) => contexts.includes(name),
    )?.command.id;
    expect(press(["chatFocus", "composerFocus", "editableFocus", "planOpen"])).toBe("plan.toggle");
    // Shift+Tab goes back through the page: from a footer chip, the transcript, a form, a terminal or the Files editor.
    expect(press([])).toBeUndefined();
    expect(press(["chatFocus", "composerFocus"])).toBeUndefined();
    expect(press(["chatFocus"])).toBeUndefined();
    expect(press(["editableFocus"])).toBeUndefined();
    expect(press(["terminalFocus", "editableFocus"])).toBeUndefined();
    expect(press(["editorFocus", "editableFocus"])).toBeUndefined();
    // A dialog or menu over the composer takes it, and so does a question waiting there.
    expect(press(["composerFocus", "editableFocus", "planOpen", "overlayOpen"])).toBeUndefined();
    expect(press(["composerFocus", "editableFocus", "planOpen", "questionFocus"])).toBeUndefined();
    // Without the runtime's plan mode (or on a Read-only device) the composer never says `planOpen`.
    expect(press(["composerFocus", "editableFocus"])).toBeUndefined();
    const toggle = registry.getCommands().find((command) => command.id === "plan.toggle")!;
    const planning = actionsFor();
    await toggle.run(planning);
    expect(planning.setMode).toHaveBeenLastCalledWith("default");
    const building = actionsFor({ activeThread: () => ({ sessionId: "s1", cwd: "/repo", draftPending: false, mode: "default", modes: ["plan"] }) as never });
    await toggle.run(building);
    expect(building.setMode).toHaveBeenLastCalledWith("plan");
    const noPlan = actionsFor({ activeThread: () => ({ sessionId: "s1", cwd: "/repo", draftPending: false }) as never });
    await toggle.run(noPlan);
    expect(noPlan.setMode).not.toHaveBeenCalled();
    expect(noPlan.notify).toHaveBeenCalledWith("This thread's runtime has no plan mode.");
  });

  describe("Shift+Tab through the real dispatcher", () => {
    /** The composer as core draws it: the footer, its prompt field, a chip and the footer controls the registry holds. */
    const page = (registry: ReturnType<typeof createKitHarness>["registry"], actions: WorkbenchActions, fields: { snapshot?: HostSnapshot; asking?: boolean; dialog?: boolean } = {}) => {
      const marker = registry.getComposerControls().find((entry) => entry.id === "plan.key-context")!;
      return (
        <>
          <footer data-keybinding-context={fields.asking ? "composer question" : "composer"}>
            <textarea aria-label="Prompt" />
            <button type="button">Model</button>
            <marker.Component snapshot={fields.snapshot ?? snapshot({ modes: ["plan"] })} actions={actions} />
          </footer>
          <input aria-label="Name" />
          {fields.dialog ? <div role="dialog" aria-label="Rename"><input aria-label="Title" /></div> : null}
        </>
      );
    };
    /** Returns whether the key was left to the browser. */
    const shiftTab = (name: string, role: "textbox" | "button") => {
      const target = screen.getByRole(role, { name });
      target.focus();
      return fireEvent.keyDown(target, { key: "Tab", code: "Tab", shiftKey: true });
    };
    const setup = () => {
      const { registry } = createKitHarness();
      registry.activate(planKitExtension);
      const actions = actionsFor();
      const onNotice = vi.fn();
      renderHook(() => useAppKeybindings(registry, actions, onNotice));
      return { registry, actions, onNotice };
    };

    it("takes the key only from the composer's text field, leaving every other field and dialog to move focus back", async () => {
      const { registry, actions } = setup();
      const view = render(page(registry, actions));
      expect(shiftTab("Prompt", "textbox")).toBe(false);
      await vi.waitFor(() => expect(actions.setMode).toHaveBeenCalledTimes(1));
      expect(actions.setMode).toHaveBeenLastCalledWith("default");
      expect(shiftTab("Model", "button")).toBe(true);
      expect(shiftTab("Name", "textbox")).toBe(true);
      view.rerender(page(registry, actions, { dialog: true }));
      expect(shiftTab("Title", "textbox")).toBe(true);
      expect(shiftTab("Prompt", "textbox")).toBe(true);
      expect(actions.setMode).toHaveBeenCalledTimes(1);
    });

    it("moves focus back, without a notice, where the thread's runtime has no plan mode", () => {
      const { registry, actions, onNotice } = setup();
      const view = render(page(registry, actions, { snapshot: snapshot({}) }));
      expect(shiftTab("Prompt", "textbox")).toBe(true);
      // A runtime that offers other modes but not this one.
      view.rerender(page(registry, actions, { snapshot: snapshot({ modes: ["review"] }) }));
      expect(shiftTab("Prompt", "textbox")).toBe(true);
      expect(actions.setMode).not.toHaveBeenCalled();
      expect(actions.notify).not.toHaveBeenCalled();
      expect(onNotice).not.toHaveBeenCalled();
    });

    it("moves focus back, without a notice, on a device paired Read only", () => {
      const { registry, actions, onNotice } = setup();
      setHostClient(createFakeHostClient({ isReadOnly: () => true }));
      render(page(registry, actions));
      expect(shiftTab("Prompt", "textbox")).toBe(true);
      expect(actions.setMode).not.toHaveBeenCalled();
      expect(onNotice).not.toHaveBeenCalled();
    });

    it("moves focus back from a question's field instead of toggling plan mode", () => {
      const { registry, actions, onNotice } = setup();
      const view = render(page(registry, actions, { asking: true }));
      expect(shiftTab("Prompt", "textbox")).toBe(true);
      expect(actions.setMode).not.toHaveBeenCalled();
      expect(onNotice).not.toHaveBeenCalled();
      // The answer is in; the prompt field is the prompt field again.
      view.rerender(page(registry, actions, { asking: false }));
      expect(shiftTab("Prompt", "textbox")).toBe(false);
    });
  });

  it("draws a proposed plan as a card with its title", () => {
    const { registry } = createKitHarness();
    registry.activate(planKitExtension);
    const block = registry.getMessageBlocks().find((entry) => entry.tag === "proposed_plan")!;
    render(
      <WorkbenchShellContext.Provider value={{ registry, actions: actionsFor() }}>
        <block.Component body={plan} attributes={{}} complete message={{ id: "a1", role: "assistant", text: "", timestamp: 0 }} streaming={false} />
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
