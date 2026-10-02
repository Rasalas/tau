// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";

afterEach(() => {
  cleanup();
  setHostClient(undefined);
  setClientStorage(undefined);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settleFocus() {
  // Include the delayed thread-opening focus, even when the verdict is no focus.
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
}

describe("thread-opening composer focus", () => {
  it.each([true, false])("opens and switches threads with touch=%s", async (touch) => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: touch && query === "(pointer: coarse)", media: query,
      addEventListener() {}, removeEventListener() {},
    })));
    const detail = (sessionId: string) => ({
      sessionId, messages: [{ id: sessionId, role: "user" as const, text: sessionId, timestamp: 1 }],
      isStreaming: false, activeTools: [],
    });
    const client = createFakeHostClient({
      bootstrap: async () => ({
        version: 1, threadIndex: { projects: [], sessions: [] }, detail: detail("first"),
        catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
        project: { cwd: "/project" },
      }),
      switchSession: async (path) => ({ version: 1, updates: [{ version: 1, type: "thread-detail", detail: detail(path) }] }),
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    renderApp(client, { extensions: [{
      id: "test.navigation", name: "Navigation", activate(context) {
        context.registerRegion({ id: "switch", placement: "composer-above", Component: ({ actions }) =>
          <>
            <button type="button" onClick={() => { void actions?.switchSession("second"); }}>Open second thread</button>
            <button type="button" onClick={() => actions?.focusComposer()}>Write a reply</button>
          </> });
      },
    }] });
    await settleFocus();
    const composer = screen.getByRole("textbox");
    expect(document.activeElement === composer).toBe(!touch);

    composer.blur();
    fireEvent.click(screen.getByRole("button", { name: "Open second thread" }));
    await settleFocus();
    expect(screen.getByText("second")).toBeTruthy();
    expect(document.activeElement === composer).toBe(!touch);

    // Explicitly starting to write still focuses the field on touch.
    fireEvent.click(screen.getByRole("button", { name: "Write a reply" }));
    expect(document.activeElement).toBe(composer);
  });
});
