// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension, UiSession } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { WORKSPACE_STORE_SERVICE, type RailExternalThread, type WorkspaceStoreApi } from "./protocol.js";
import { mergeByTime } from "./rail-external.js";
import { shelfRoom } from "./rail-shelf-room.js";

// The main list is virtual; jsdom measures nothing, so every box gets a size and the rows draw.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 80, width: 300, height: 80, toJSON: () => ({}) });
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const session = (id: string, modifiedAt: number, patch: Partial<UiSession> = {}): UiSession => ({
  id, path: `/sessions/${id}.jsonl`, title: `Thread ${id}`, modifiedAt, projectPath: "/projects/api", projectName: "api", messageCount: 2, ...patch,
});

function source(initial: RailExternalThread[]) {
  const listeners = new Set<() => void>();
  let threads = initial;
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    threads: () => threads,
    set(next: RailExternalThread[]) { threads = next; act(() => listeners.forEach((listener) => listener())); },
  };
}

function remote(id: string, modifiedAt: number, patch: Partial<RailExternalThread> = {}, sessionPatch: Partial<UiSession> = {}): RailExternalThread {
  return {
    key: `machine:rex:${id}`,
    session: session(`machine:rex:${id}`, modifiedAt, { title: `Remote ${id}`, projectPath: "rex:api", ...sessionPatch }),
    machine: { name: "rex", icon: <svg data-testid="rex-icon" /> },
    open: vi.fn(),
    ...patch,
  };
}

async function renderRail(threads: RailExternalThread[], own: UiSession[]) {
  const outside = source(threads);
  const listing: DesktopExtension = {
    id: "test.machines",
    name: "Machines",
    activate: (context) => context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => store.registerRailThreads?.(outside)),
  };
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/projects/api", name: "api", lastOpenedAt: 1 }], sessions: own },
      detail: { sessionId: own[0]!.id, messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: own[0]!.id, models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/projects/api" },
    }),
    invokeHostExtension: workspaceHostStub(),
  });
  const rendered = renderApp(client, { extensions: [workspaceExtension, listing] });
  const rail = await screen.findByRole("navigation", { name: "Threads" });
  await within(rail).findByText(own[0]!.title);
  return { ...rendered, rail, outside };
}

const titles = (rail: HTMLElement) => [...rail.querySelectorAll(".rail-active .thread-title")].map((title) => title.textContent);

describe("other machines' threads in the rail", () => {
  it("stand among this machine's by time, with the machine's mark just before the cost", async () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0.75, turns: 1 };
    const { rail } = await renderRail([remote("r1", 25, {}, { usage })], [session("a", 30), session("b", 20)]);
    expect(titles(rail)).toEqual(["Thread a", "Remote r1", "Thread b"]);
    expect(within(rail).queryByText("Other machines")).toBeNull();
    const row = within(rail).getByText("Remote r1").closest(".thread-row") as HTMLElement;
    const mark = within(row).getByRole("img", { name: "On rex" });
    const cost = within(row).getByText("$0.75");
    expect(mark.compareDocumentPosition(cost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // This machine's threads carry no mark, and another machine's cannot be settled here.
    expect(within(within(rail).getByText("Thread a").closest(".thread-row") as HTMLElement).queryByRole("img", { name: /^On / })).toBeNull();
    expect(within(row).queryByRole("button", { name: /^Settle/u })).toBeNull();
  });

  it("opens there on a click, and not while the machine is out of reach", async () => {
    const reachable = remote("r1", 25);
    const offline = remote("r2", 24, { unavailable: "rex is offline." });
    const { rail } = await renderRail([reachable, offline], [session("a", 30)]);
    fireEvent.click(within(rail).getByText("Remote r1"));
    expect(reachable.open).toHaveBeenCalledTimes(1);
    fireEvent.click(within(rail).getByText("Remote r2"));
    expect(offline.open).not.toHaveBeenCalled();
    expect(within(rail).getByText("Remote r2").closest(".rail-external")?.classList.contains("unavailable")).toBe(true);
  });

  it("offers a look-in where the source has one", async () => {
    const lookIn = vi.fn();
    const { rail } = await renderRail([remote("r1", 25, { lookIn })], [session("a", 30)]);
    fireEvent.click(within(rail).getByRole("button", { name: "Look in on Remote r1 here" }));
    expect(lookIn).toHaveBeenCalledTimes(1);
  });

  it("follows the search and the project filter like this machine's threads", async () => {
    const { rail } = await renderRail([remote("r1", 25), remote("r2", 24, {}, { projectName: "web", title: "Remote web" })], [session("a", 30)]);
    fireEvent.change(screen.getByRole("textbox", { name: "Search threads" }), { target: { value: "web" } });
    expect(titles(rail)).toEqual(["Remote web"]);
  });

  it("follows the source when its threads change", async () => {
    const { rail, outside } = await renderRail([], [session("a", 30)]);
    expect(titles(rail)).toEqual(["Thread a"]);
    outside.set([remote("r1", 40, { running: true })]);
    expect(titles(rail)).toEqual(["Remote r1", "Thread a"]);
  });
});

describe("the rail's shelves", () => {
  it("sit under the active threads in a scroller of their own", async () => {
    const own = [session("a", 30), session("b", 20)];
    const { rail, services } = await renderRail([], own);
    act(() => services.preferences.toggleSettled("b"));
    const shelves = rail.querySelector(".rail-shelves") as HTMLElement;
    expect(within(shelves).getByRole("button", { name: /Settled · 1/u })).toBeTruthy();
    expect(within(shelves).getByText("Thread b")).toBeTruthy();
    expect(within(rail.querySelector(".rail-active") as HTMLElement).queryByText("Thread b")).toBeNull();
  });

  it("take a third of the rail when both are long, and all the active threads leave when those are few", () => {
    expect(shelfRoom(900, 2_000)).toBe(300);
    expect(shelfRoom(900, 200)).toBe(700);
    expect(shelfRoom(900, 900)).toBe(300);
  });
});

describe("merging by time", () => {
  it("keeps the rail's own order and puts each outside thread before the first it is newer than", () => {
    const own = [session("pinned-by-hand", 5), session("a", 30), session("b", 20)];
    const merged = mergeByTime(own, [session("x", 25), session("y", 1), session("z", 40)], "updated");
    expect(merged.map((entry) => entry.id)).toEqual(["z", "x", "pinned-by-hand", "a", "b", "y"]);
    expect(mergeByTime(own, [], "updated")).toEqual(own);
    expect(mergeByTime([session("a", 30, { createdAt: 1 })], [session("x", 10, { createdAt: 5 })], "created").map((entry) => entry.id)).toEqual(["x", "a"]);
  });
});
