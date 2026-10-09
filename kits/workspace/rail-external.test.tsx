// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtension, UiSession, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import threadRailExtension from "../thread-rail/desktop.js";
import { workspaceExtension } from "./desktop.js";
import { WORKSPACE_STORE_SERVICE, type RailExternalThread, type WorkspaceStoreApi } from "./protocol.js";
import { mergeByTime, outsideThreadItems } from "./rail-external.js";

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

async function renderRail(threads: RailExternalThread[], own: UiSession[], working = false) {
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
    invokeHostExtension: working ? async (extension, command, input) => extension === "tau.thread-rail" && command === "state" ? { threads: {}, settings: { onMerged: true, onClosed: false, workingSection: true } } : workspaceHostStub()(extension, command, input) : workspaceHostStub(),
  });
  const rendered = renderApp(client, { extensions: [workspaceExtension, listing, ...(working ? [threadRailExtension] : [])] });
  const rail = await screen.findByRole("navigation", { name: "Threads" });
  await within(rail).findByText(own[0]!.title);
  return { ...rendered, rail, outside, client };
}

const titles = (rail: HTMLElement) => [...rail.querySelectorAll(".rail-active .thread-title")].filter((title) => !title.closest(".rail-shelves")).map((title) => title.textContent);

describe("other machines' threads in the rail", () => {
  it("hides externally supplied subagent threads in every rail section", async () => {
    const children = [
      remote("agent-active", 31, {}, { parentThreadId: "parent" }),
      remote("agent-running", 32, { running: true }, { parentThreadId: "parent" }),
      remote("agent-settled", 33, { settled: true }, { parentThreadId: "parent" }),
    ];
    const { rail } = await renderRail([remote("ordinary", 29), ...children], [session("a", 30)], true);
    await within(rail).findByText("Remote ordinary");
    for (const child of children) expect(within(rail).queryByText(child.session.title)).toBeNull();
  });

  it("shows an own-index machine proxy as an ordinary selectable row with its home runtime", async () => {
    const proxy = session("rex~t1", 25, {
      backendKind: "machine", modelProvider: "anthropic",
      machine: { id: "rex", name: "rex", backendKind: "codex", modelProvider: "openai" },
    });
    const { rail, client } = await renderRail([], [session("a", 30), proxy]);
    const title = await within(rail).findByText(proxy.title);
    const row = title.closest(".thread-row") as HTMLElement;
    expect(await within(row).findByRole("img", { name: "On rex" })).toBeTruthy();
    expect(await within(row).findByLabelText(/^Codex.*OpenAI/)).toBeTruthy();
    expect(row.closest(".rail-external")).toBeNull();
    fireEvent.click(title);
    expect(client.calls.filter((call) => call.method === "switchSession").at(-1)?.args[0]).toBe(proxy.path);
  });

  it("stand among this machine's by time, with the machine's mark and no cost on the row", async () => {
    const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2, costUsd: 0.75, turns: 1 };
    const { rail } = await renderRail([remote("r1", 25, {}, { usage })], [session("a", 30), session("b", 20)]);
    expect(titles(rail)).toEqual(["Thread a", "Remote r1", "Thread b"]);
    expect(within(rail).queryByText("Other machines")).toBeNull();
    const row = within(rail).getByText("Remote r1").closest(".thread-row") as HTMLElement;
    const mark = within(row).getByRole("img", { name: "On rex" });
    expect(mark.closest(".thread-meta-end")).toBeTruthy();
    // The cost is the hover card's.
    expect(within(row).queryByText("$0.75")).toBeNull();
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

  it("put a thread settled on its machine on the settled shelf, and settle one there", async () => {
    const toggleSettled = vi.fn();
    const { rail } = await renderRail([remote("r1", 25, { toggleSettled }), remote("r2", 24, { settled: true, toggleSettled: vi.fn() })], [session("a", 30)]);
    expect(titles(rail)).toEqual(["Thread a", "Remote r1"]);
    const shelf = rail.querySelector(".settled-shelf") as HTMLElement;
    expect(within(shelf).getByText("Remote r2")).toBeTruthy();
    fireEvent.click(within(rail).getByRole("button", { name: "Settle Remote r1" }));
    expect(toggleSettled).toHaveBeenCalledTimes(1);
  });

  it("offers a look-in where the source has one", async () => {
    const lookIn = vi.fn();
    const { rail } = await renderRail([remote("r1", 25, { lookIn })], [session("a", 30)]);
    fireEvent.click(within(rail).getByRole("button", { name: "Look in on Remote r1 here" }));
    expect(lookIn).toHaveBeenCalledTimes(1);
  });

  it("are found by the palette's Threads, by project, title or machine, and open from there", () => {
    const web = remote("r2", 24, {}, { projectName: "web", title: "Remote web" });
    const outside = source([remote("r1", 25), web, remote("r3", 23, { unavailable: "rex is offline." }, { projectName: "web", title: "Offline web" })]);
    expect(outsideThreadItems([outside], "")).toEqual([]);
    const found = outsideThreadItems([outside], "web rex");
    expect(found.map((item) => [item.label, item.detail])).toEqual([["Remote web", "web · on rex"]]);
    const actions = {} as WorkbenchActions;
    found[0]!.run!(actions);
    expect(web.open).toHaveBeenCalledWith(actions);
  });

  it("follows the source when its threads change", async () => {
    const { rail, outside } = await renderRail([], [session("a", 30)]);
    expect(titles(rail)).toEqual(["Thread a"]);
    outside.set([remote("r1", 40, { running: true })]);
    expect(titles(rail)).toEqual(["Remote r1", "Thread a"]);
  });
});

describe("the rail's shelves", () => {
  it("follow the active threads in the one scroller, open under their count until folded", async () => {
    const own = [session("a", 30), session("b", 20), session("c", 10)];
    const { rail, services } = await renderRail([], own);
    act(() => { services.preferences.toggleSettled("b"); services.preferences.toggleSettled("c"); });
    const active = rail.querySelector(".rail-active") as HTMLElement;
    const shelves = active.querySelector(".rail-shelves") as HTMLElement;
    const toggle = within(shelves).getByRole("button", { name: "Settled" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(shelves).getByText("Thread b")).toBeTruthy();
    expect(titles(rail)).toEqual(["Thread a"]);
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("Settled");
    expect(within(rail).queryByText("Thread b")).toBeNull();
  });

  it("sit at the bottom of short lists and scroll with the active threads", () => {
    // jsdom lays nothing out, so the rules that do are read from the stylesheet.
    const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");
    const rule = (selector: string) => new RegExp(`^${selector.replace(".", "\\.")} \\{([^}]*)\\}`, "mu").exec(css)?.[1] ?? "";
    expect(rule(".rail-active")).toMatch(/overflow: auto;[^}]*display: flex; flex-direction: column/u);
    expect(rule(".rail-active-rows")).toMatch(/flex: 1 0 auto/u);
    expect(rule(".rail-shelves")).toMatch(/margin-top: auto/u);
    expect(rule(".rail-shelves")).not.toMatch(/overflow|flex: 0 0/u);
  });

  it("draw the design's 70 px cards 2 px apart", () => {
    const kit = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");
    const core = readFileSync(join(import.meta.dirname, "../../src/renderer/styles.css"), "utf8");
    const rule = (css: string, selector: string) => new RegExp(`^${selector.replace(/\./gu, "\\.")} \\{([^}]*)\\}`, "mu").exec(css)?.[1] ?? "";
    expect(rule(kit, ".rail-virtual > .rail-row")).toMatch(/padding-bottom: 2px/u);
    // 1 + 7 + 16 + 2 + 18 + 2 + 16 + 7 + 1 = 70.
    expect(rule(core, ".thread-main")).toMatch(/padding: calc\(7px \* var\(--density\)\)/u);
    expect(rule(core, ".thread-project-line")).toMatch(/height: 16px/u);
    expect(rule(core, ".thread-title")).toMatch(/margin-top: calc\(2px \* var\(--density\)\);[^}]*line-height: 18px/u);
  });
});

describe("merging by time", () => {
  it("keeps the rail's own order and puts each outside thread before the first it is newer than", () => {
    const own = [session("pinned-by-hand", 5), session("a", 30), session("b", 20)];
    const merged = mergeByTime(own, [session("x", 25), session("y", 1), session("z", 40)]);
    expect(merged.map((entry) => entry.id)).toEqual(["z", "x", "pinned-by-hand", "a", "b", "y"]);
    expect(mergeByTime(own, [])).toEqual(own);
    expect(mergeByTime([session("a", 30, { createdAt: 1 })], [session("x", 10, { createdAt: 5 })]).map((entry) => entry.id)).toEqual(["x", "a"]);
  });
});


it("moves remote work back to attention for a question, completion or disconnection", async () => {
  const { rail, outside } = await renderRail([remote("r1", 40, { running: true })], [session("a", 30)], true);
  const working = () => rail.querySelector(".rail-section-working");
  await waitFor(() => expect(working()?.textContent).toContain("Working"));
  fireEvent.click(within(working() as HTMLElement).getByRole("button", { expanded: false }));
  await within(working() as HTMLElement).findByText("Remote r1");
  expect(titles(rail)).toEqual(["Thread a"]);
  act(() => outside.set([remote("r1", 40, { running: true, waiting: true })]));
  await waitFor(() => expect(titles(rail)).toEqual(["Remote r1", "Thread a"]));
  act(() => outside.set([remote("r1", 40, { running: true })]));
  await waitFor(() => expect(titles(rail)).toEqual(["Thread a"]));
  act(() => outside.set([remote("r1", 40, { running: false })]));
  await waitFor(() => expect(titles(rail)).toEqual(["Remote r1", "Thread a"]));
  act(() => outside.set([remote("r1", 40, { running: true, unavailable: "Disconnected" })]));
  await waitFor(() => expect(titles(rail)).toEqual(["Remote r1", "Thread a"]));
});
