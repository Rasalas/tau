// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts";
import type { DesktopExtension } from "../renderer/extension-system";
import { installPointerEvents } from "../renderer/test-support/pointer-events";
import { setHostClient } from "../renderer/host-client-context";
import { createFakeHostClient } from "../renderer/test-support/fake-host-client";
import { createKitHarness } from "../renderer/test-support/kit-harness";
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

/** A branch to show on the meta line, one on the default branch, and one the user settled. */
const THREADS = [thread("t-branch", "Rename the store", 30, "feat/store"), thread("t-bare", "Fix the flaky test", 20, "main"), thread("t-settled", "Old work", 10)];

/** A kit that marks every row with its thread's id; `Marked` is the settled flag it was given. */
const marks: DesktopExtension = {
  id: "test.marks",
  name: "Row marks",
  activate(context) {
    context.registerThreadListAccessory({
      id: "test.marks",
      Component: ({ session, settled }) => <span className="test-mark" data-settled={String(settled)}>{`mark ${session.id}`}</span>,
    });
  },
};

const mute: DesktopExtension = {
  id: "test.mute",
  name: "Row marks that say nothing",
  activate(context) {
    context.registerThreadListAccessory({ id: "test.mute", Component: () => null });
  },
};

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

const row = (home: HTMLElement, title: string) => within(home).getByRole("button", { name: `Open thread ${title}` });

beforeEach(() => { installPointerEvents(); setViewport(400); });
afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); setViewport(1024); window.history.replaceState(null, "", "/"); });

describe("a kit's marks on the phone's thread rows", () => {
  it("draw beside the branch, between the branch and the runtime mark, as on the rail", async () => {
    const home = await renderList([marks]);
    const line = row(home, "Rename the store").querySelector(".thread-meta-line")!;
    // Right to left in the DOM: the runtime mark, the kits' marks, then the branch.
    expect([...line.children].map((child) => child.className)).toEqual(["thread-meta-end", "thread-meta-marks", "thread-branch"]);
    expect(line.querySelector(".thread-meta-marks")!.textContent).toBe("mark t-branch");
  });

  it("ride on the title's line when the row has no branch to show, so it gains no third line", async () => {
    const home = await renderList([marks]);
    const bare = row(home, "Fix the flaky test");
    expect(bare.querySelector(".thread-meta-line")).toBeNull();
    expect([...bare.querySelector(".touch-title-line")!.children].map((child) => child.className)).toEqual(["thread-title", "thread-meta-marks", "thread-meta-end"]);
    expect(bare.querySelector(".touch-title-line .thread-meta-marks")!.textContent).toBe("mark t-bare");
  });

  it("follow a settled thread onto the shelf, told that it is settled", async () => {
    const home = await renderList([marks]);
    const shelf = within(home).getByRole("list", { name: "Settled threads" });
    const settled = within(shelf).getByRole("button", { name: "Open thread Old work" });
    expect([...settled.children].map((child) => child.className)).toEqual(["thread-project-icon", "thread-title", "thread-meta-marks", ""]);
    const mark = settled.querySelector<HTMLElement>(".test-mark")!;
    expect([mark.textContent, mark.dataset.settled]).toEqual(["mark t-settled", "true"]);
    expect(row(home, "Rename the store").querySelector<HTMLElement>(".test-mark")!.dataset.settled).toBe("false");
  });

  it("leave a row as it was without a kit, or when the kit has nothing to say", async () => {
    const without = await renderList([]);
    expect(without.querySelector(".thread-meta-marks")).toBeNull();
    cleanup();
    const mutely = await renderList([mute]);
    // The wrapper stays empty and the stylesheet hides it, so the row's spacing is unchanged.
    const wrappers = [...mutely.querySelectorAll(".thread-meta-marks")];
    expect(wrappers.length).toBeGreaterThan(0);
    for (const wrapper of wrappers) expect(wrapper.childNodes.length).toBe(0);
  });

  it("are gone again when the kit is", async () => {
    const home = await renderList([marks]);
    expect(home.querySelectorAll(".test-mark")).toHaveLength(3);
    cleanup();
    expect((await renderList([])).querySelectorAll(".test-mark")).toHaveLength(0);
  });
});

describe("the registry's thread list accessories", () => {
  it("are listed in registration order, keep their identity until something changes, and go with their kit", () => {
    const { registry } = createKitHarness();
    registry.activate(marks);
    registry.activate(mute);
    const list = registry.getThreadListAccessories();
    expect(list.map((accessory) => accessory.id)).toEqual(["test.marks", "test.mute"]);
    expect(registry.getThreadListAccessories()).toBe(list);
    registry.deactivate(marks.id);
    expect(registry.getThreadListAccessories().map((accessory) => accessory.id)).toEqual(["test.mute"]);
  });
});
