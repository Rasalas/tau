// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts";
import type { DesktopExtension } from "../renderer/extension-system";
import { installPointerEvents } from "../renderer/test-support/pointer-events";
import { setHostClient } from "../renderer/host-client-context";
import { createFakeHostClient } from "../renderer/test-support/fake-host-client";
import { workspaceHostStub } from "../renderer/test-support/workspace-host-stub";
import { createRendererServices } from "../renderer/renderer-services";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { WebWorkbench, webClientEnvironment } from "./WebWorkbench";

const kitModules = import.meta.glob<{ default: DesktopExtension }>("../../kits/workspace/desktop.tsx");
const { default: workspaceExtension } = await kitModules["../../kits/workspace/desktop.tsx"]!();

/** The part of Workspace Kit's store a kit like Terminal or Review marks rows through. */
interface Store {
  registerThreadRowAccessory(accessory: ComponentType<{ session: UiSession }>): () => void;
  recordTurnStat(sessionId: string, stat: { added: number; removed: number; files: number; at: number }): void;
}

function setViewport(width: number, height = 844): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true, writable: true });
  Object.defineProperty(window.screen, "width", { value: width, configurable: true });
  Object.defineProperty(window.screen, "height", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

function thread(id: string, title: string, modifiedAt: number): UiSession {
  return { id, path: `/sessions/${id}.json`, title, modifiedAt, projectPath: "/project", projectName: "project", projectLabel: "feat/store", messageCount: 2 };
}

let workspace: Store | undefined;
/** What Terminal and Review Kit do: a mark for a thread on the rail's accessory list. */
const marking: DesktopExtension = {
  id: "test.marking",
  name: "Marking",
  activate: (context) => context.useService<Store>("tau.workspace/store", (store) => {
    workspace = store;
    return store.registerThreadRowAccessory(({ session }) => <span role="img" aria-label={`terminal running in ${session.id}`} />);
  }),
};

const STATS = { "t-active": { added: 12, removed: 3, files: 2, at: 1 }, "t-settled": { added: 5, removed: 1, files: 1, at: 1 } };

async function renderPhone() {
  const host = workspaceHostStub();
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1 as const,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [thread("t-active", "Rename the store", 20), thread("t-settled", "Old work", 10)] },
      detail: { sessionId: "t-active", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "t-active", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: (id, command, input) => id === "tau.workspace" && command === "turn-stats" ? Promise.resolve(STATS) : host(id, command, input),
  });
  const storage = createMemoryStorage();
  setHostClient(client);
  setClientStorage(storage);
  const services = createRendererServices([workspaceExtension, marking]);
  services.preferences.toggleSettled("t-settled");
  render(<WebWorkbench client={client} storage={storage} services={services} environment={webClientEnvironment("compact")} />);
  return within(await screen.findByRole("region", { name: "Threads" }));
}

beforeEach(() => { installPointerEvents(); setViewport(400); });
afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); setViewport(1024); window.history.replaceState(null, "", "/"); });

describe("the rail's row marks on the phone's thread list", () => {
  it("shows the last turn's changes and every kit's mark, as the rail does", async () => {
    const home = await renderPhone();
    const row = await home.findByRole("button", { name: "Open thread Rename the store" });
    const stat = await within(row).findByLabelText("Last turn: 12 lines added, 3 removed");
    expect(stat.textContent).toBe("+12 −3");
    expect(within(row).getByRole("img", { name: "terminal running in t-active" })).toBeTruthy();
    // The wrapper the branch sits beside, the changes first.
    expect([...row.querySelector(".thread-meta-marks")!.children].map((child) => child.className || child.getAttribute("role"))).toEqual(["thread-diff-stat", "img"]);
  });

  it("leaves the changes off a settled thread and keeps the kits' marks, as the rail does", async () => {
    const home = await renderPhone();
    const shelf = within(await home.findByRole("list", { name: "Settled threads" }));
    const row = shelf.getByRole("button", { name: "Open thread Old work" });
    expect(within(row).getByRole("img", { name: "terminal running in t-settled" })).toBeTruthy();
    await act(async () => { workspace!.recordTurnStat("t-settled", { added: 7, removed: 2, files: 1, at: 2 }); });
    expect(row.querySelector(".thread-diff-stat")).toBeNull();
  });

  it("follows a turn's new changes", async () => {
    const home = await renderPhone();
    const row = await home.findByRole("button", { name: "Open thread Rename the store" });
    await within(row).findByLabelText("Last turn: 12 lines added, 3 removed");
    await act(async () => { workspace!.recordTurnStat("t-active", { added: 40, removed: 8, files: 3, at: 2 }); });
    expect(within(row).getByLabelText("Last turn: 40 lines added, 8 removed").textContent).toBe("+40 −8");
  });
});
