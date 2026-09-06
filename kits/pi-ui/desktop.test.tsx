// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, WorkbenchActions } from "tau";
import { createKitHarness } from "../../src/renderer/test-support/kit-harness.js";
import { createPiUiExtension, PiUiStore, stripAnsi } from "./desktop.js";

const snapshot = (sessionId: string, isStreaming = false) => ({ sessionId, isStreaming } as HostSnapshot);
const actions = {} as WorkbenchActions;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(cleanup);

describe("Pi UI extension", () => {
  it("shows the active thread's statuses and widgets and drops them with the thread", async () => {
    const invoke = vi.fn(async (_id: string, command: string, input?: unknown) => {
      if (command !== "state") throw new Error(command);
      const sessionId = (input as { sessionId?: string } | undefined)?.sessionId ?? "s1";
      return sessionId === "s1"
        ? { sessionId, statuses: [{ key: "vim", text: "\u001b[32mNORMAL\u001b[0m" }], widgets: [{ key: "todo", lines: ["[ ] tests"], placement: "belowEditor" }], working: "Thinking" }
        : { sessionId, statuses: [], widgets: [] };
    });
    const { registry } = createKitHarness(invoke);
    const store = new PiUiStore();
    registry.activate(createPiUiExtension(store));
    await flush();
    const status = registry.getStatusItems().find((item) => item.id === "pi-ui.status")!;
    const below = registry.getRegions("composer-below").find((region) => region.id === "pi-ui.widgets-below")!;
    const above = registry.getRegions("composer-above").find((region) => region.id === "pi-ui.widgets-above")!;
    const view = render(<>
      <status.Component snapshot={snapshot("s1", true)} actions={actions} />
      <above.Component snapshot={snapshot("s1")} actions={actions} />
      <below.Component snapshot={snapshot("s1")} actions={actions} />
    </>);
    expect(screen.getByTitle("vim").textContent).toBe("NORMAL");
    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(view.container.querySelector('[data-widget="todo"]')?.textContent).toBe("[ ] tests");

    // The host publishes a change; the working message hides once the run ends.
    registry.dispatchExtensionEvent({ type: "extension-event", extensionId: "tau.pi-ui", name: "state", payload: { sessionId: "s1", statuses: [], widgets: [{ key: "todo", lines: ["[x] tests"], placement: "belowEditor" }], working: "Thinking" } });
    view.rerender(<>
      <status.Component snapshot={snapshot("s1", false)} actions={actions} />
      <below.Component snapshot={snapshot("s1")} actions={actions} />
    </>);
    expect(screen.queryByTitle("vim")).toBeNull();
    expect(screen.queryByText("Thinking")).toBeNull();
    expect(view.container.querySelector('[data-widget="todo"]')?.textContent).toBe("[x] tests");

    // Another thread shows nothing of the first.
    registry.dispatchWorkbenchEvent({ type: "active-thread-changed", sessionId: "s2" });
    await flush();
    view.rerender(<below.Component snapshot={snapshot("s2")} actions={actions} />);
    expect(view.container.querySelector(".pi-ui-widget")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("tau.pi-ui", "state", { sessionId: "s2" });
    expect(stripAnsi("\u001b[1mbold\u001b[22m [x] kept")).toBe("bold [x] kept");
  });
});
