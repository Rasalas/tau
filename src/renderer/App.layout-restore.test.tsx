// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { setHostClient } from "./host-client-context";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { dockStateKey } from "../workbench/storage-keys";
import type { DesktopExtension } from "./extension-system";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

function projectClient() {
  return createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [], sessions: [] },
      detail: { sessionId: "session", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: "/project" },
    }),
  });
}

describe("App layout restore", () => {
  it("keeps a restored dock panel whose kit offers it after another kit's panel", async () => {
    const storage = createMemoryStorage();
    storage.set(dockStateKey("/project"), JSON.stringify({ open: true, activePanel: "late", openedPanels: ["early", "late"] }));
    let arrive: (() => void) | undefined;
    const early: DesktopExtension = {
      id: "test.early", name: "Early",
      activate: (plugin) => { plugin.registerPanel({ id: "early", label: "Early", order: 1, Component: () => <div>early panel</div> }); },
    };
    // Kits activate one after another; this one's panel arrives when the test says so.
    const late: DesktopExtension = {
      id: "test.late", name: "Late",
      activate: (plugin) => { arrive = () => { plugin.registerPanel({ id: "late", label: "Late", order: 2, Component: () => <div>late panel</div> }); }; },
    };

    renderApp(projectClient(), { storage, extensions: [early, late] });
    await screen.findByRole("button", { name: "Early" });
    await screen.findByRole("button", { name: "Send" });
    act(() => arrive?.());

    const lateButton = await screen.findByRole("button", { name: "Late" });
    await waitFor(() => expect(lateButton.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: "Early" }).getAttribute("aria-pressed")).toBe("false");
    await waitFor(() => expect(JSON.parse(storage.get(dockStateKey("/project")) ?? "{}")).toMatchObject({ activePanel: "late" }));
  });
});
