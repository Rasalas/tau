// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts";
import type { DesktopExtension } from "../renderer/extension-system";
import { installPointerEvents } from "../renderer/test-support/pointer-events";
import { setHostClient } from "../renderer/host-client-context";
import { createFakeHostClient } from "../renderer/test-support/fake-host-client";
import { createRendererServices } from "../renderer/renderer-services";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { WebWorkbench, webClientEnvironment } from "./WebWorkbench";

function setViewport(width: number, height = 844): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
  Object.defineProperty(window.screen, "width", { value: width, configurable: true });
  Object.defineProperty(window.screen, "height", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

function thread(id: string, title: string, modifiedAt: number, projectLabel?: string): UiSession {
  return { id, path: `/sessions/${id}.json`, title, modifiedAt, projectPath: "/project", projectName: "project", messageCount: 2, ...(projectLabel ? { projectLabel } : {}) };
}

const THREADS = [thread("t-branch", "Rename the store", 30, "feat/store"), thread("t-bare", "Fix the flaky test", 20, "main"), thread("t-settled", "Old work", 10)];

async function renderList(extensions: DesktopExtension[]) {
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1 as const,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: THREADS },
      detail: { sessionId: "t-branch", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "t-branch", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false },
      project: { cwd: "/project" },
    }),
  });
  const storage = createMemoryStorage();
  setHostClient(client);
  setClientStorage(storage);
  const services = createRendererServices(extensions);
  services.preferences.toggleSettled("t-settled");
  render(<WebWorkbench client={client} storage={storage} services={services} environment={webClientEnvironment("compact")} />);
  const home = await screen.findByRole("region", { name: "Threads" });
  await within(home).findByRole("button", { name: "Open thread Rename the store" });
  return home;
}

beforeEach(() => { installPointerEvents(); setViewport(400); });
afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); setViewport(1024); window.history.replaceState(null, "", "/"); });

/** A kit that turns the Working group on and off, and marks one thread as waiting on a watched request. */
function layoutKit() {
  let working = true;
  const listeners = new Set<() => void>();
  const extension: DesktopExtension = {
    id: "test.layout",
    name: "Layout",
    activate(context) {
      context.setThreadRowStatuses({ "t-bare": { label: "Waiting", tone: "background" } });
      context.registerThreadListLayout({ id: "test.layout", subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, working: () => working });
    },
  };
  return { extension, set(on: boolean) { working = on; for (const listener of [...listeners]) listener(); } };
}

describe("the phone's Working group", () => {
  it("folds a monitoring thread into a folded Working shelf while a kit's layout says so", async () => {
    const kit = layoutKit();
    const home = await renderList([kit.extension]);
    const toggle = await within(home).findByRole("button", { name: "Working · 1" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(within(home).queryByRole("button", { name: "Open thread Fix the flaky test" })).toBeNull();
    fireEvent.click(toggle);
    const shelf = await within(home).findByRole("list", { name: "Working threads" });
    await within(shelf).findByRole("button", { name: "Open thread Fix the flaky test" });
    act(() => kit.set(false));
    await waitFor(() => expect(within(home).queryByRole("button", { name: "Working · 1" })).toBeNull());
    await within(home).findByRole("button", { name: "Open thread Fix the flaky test" });
  });
});
