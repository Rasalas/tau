// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Server } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts";
import type { DesktopExtension, ThreadListEntry, WorkbenchActions } from "../renderer/extension-system";
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

function thread(id: string, title: string, modifiedAt: number, projectName = "project"): UiSession {
  return { id, path: `/sessions/${id}.json`, title, modifiedAt, projectPath: `/${projectName}`, projectName, messageCount: 2 };
}

const PROJECTS = [{ path: "/project", name: "project", lastOpenedAt: 2 }, { path: "/other", name: "other", lastOpenedAt: 1 }];

function renderList(extensions: DesktopExtension[]) {
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1 as const,
      threadIndex: { projects: PROJECTS, sessions: [thread("t-a", "Rename the store", 30), thread("t-c", "Tune the other one", 10, "other")] },
      detail: { sessionId: "t-a", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "t-a", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false },
      project: { cwd: "/project" },
    }),
  });
  const storage = createMemoryStorage();
  setHostClient(client);
  setClientStorage(storage);
  render(<WebWorkbench client={client} storage={storage} services={createRendererServices(extensions)} environment={webClientEnvironment("compact")} />);
}

/** A kit listing two threads of another machine, one of them running, the machine out of reach when `offline`. */
function machineKit(options: { offline?: boolean; opened?: string[] } = {}): DesktopExtension {
  const place = { name: "rex", icon: <Server size={12} aria-hidden /> };
  const entry = (id: string, title: string, modifiedAt: number, patch: Partial<ThreadListEntry> = {}): ThreadListEntry => ({
    key: `machine:rex:${id}`,
    session: { ...thread(id, title, modifiedAt), projectPath: `rex:project` },
    machine: place,
    ...(options.offline ? { unavailable: "rex is offline." } : {}),
    open: (_actions: WorkbenchActions) => { options.opened?.push(id); },
    ...patch,
  });
  const threads = [entry("r1", "Build on rex", 40, { running: true }), entry("r2", "Old work on rex", 5, { settled: true })];
  return {
    id: "test.machines",
    name: "Machines stub",
    activate(context) {
      context.registerThreadListSource({ id: "rex", subscribe: () => () => undefined, threads: () => threads, here: () => ({ name: "Mac", icon: <Server size={12} aria-hidden /> }) });
      context.registerRegion({ id: "rex.notice", placement: "thread-list-head", profiles: ["compact"], Component: () => <p role="status">rex not reachable</p> });
    },
  };
}

beforeEach(() => { installPointerEvents(); setViewport(400); });
afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); setViewport(1024); window.history.replaceState(null, "", "/"); });

describe("another machine's threads in the phone's list", () => {
  it("stands among this host's by state and time, names each row's machine, and opens there", async () => {
    const opened: string[] = [];
    renderList([machineKit({ opened })]);
    const home = await screen.findByRole("region", { name: "Threads" });
    const active = await within(home).findByRole("list", { name: "Threads" });
    const titles = () => within(active).getAllByRole("button", { name: /^Open thread/u }).map((button) => button.getAttribute("aria-label"));
    await waitFor(() => expect(titles()).toEqual(["Open thread Build on rex on rex", "Open thread Rename the store on Mac", "Open thread Tune the other one on Mac"]));
    const rex = within(active).getByRole("button", { name: "Open thread Build on rex on rex" });
    expect(rex.querySelector(".touch-thread-machine")?.textContent).toBe("rex");
    // No swipe tray and no actions button: it only opens there.
    expect(rex.closest("li")!.querySelector(".touch-thread-more")).toBeNull();
    fireEvent.click(rex);
    expect(opened).toEqual(["r1"]);
    // What the phone settled there sits on the shelf.
    const shelf = within(home).getByRole("list", { name: "Settled threads" });
    expect(within(shelf).getByRole("button", { name: "Open thread Old work on rex on rex" })).toBeTruthy();
    // A kit's strip tops the list.
    expect(within(home).getByRole("status").textContent).toBe("rex not reachable");
  });

  it("greys an unreachable machine's rows and says why, and keeps other projects' threads under a filter by name", async () => {
    renderList([machineKit({ offline: true })]);
    const home = await screen.findByRole("region", { name: "Threads" });
    const row = await within(home).findByRole("button", { name: "Open thread Build on rex on rex" });
    expect(row.closest("li")!.hasAttribute("data-unavailable")).toBe(true);
    expect(row.getAttribute("aria-description")).toBe("rex is offline.");
    fireEvent.click(within(home).getByRole("button", { name: "Filter threads by project" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Show threads of" })).getByRole("button", { name: /^other/u }));
    await waitFor(() => expect(within(home).queryByRole("button", { name: "Open thread Build on rex on rex" })).toBeNull());
    expect(within(home).getByRole("button", { name: "Open thread Tune the other one on Mac" })).toBeTruthy();
  });

  it("names no machine while no other machine's thread shows", async () => {
    const empty: DesktopExtension = {
      id: "test.empty",
      name: "Empty",
      activate(context) { context.registerThreadListSource({ id: "none", subscribe: () => () => undefined, threads: () => [], here: () => ({ name: "Mac", icon: null }) }); },
    };
    renderList([empty]);
    expect(await screen.findByRole("button", { name: "Open thread Rename the store" })).toBeTruthy();
    expect(document.querySelector(".touch-thread-machine")).toBeNull();
  });
});
