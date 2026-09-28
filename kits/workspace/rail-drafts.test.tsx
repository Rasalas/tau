// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostActionResult, NewThreadResult } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { createMemoryStorage, setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { railDrafts } from "./navigation.js";

// The main list is virtual; jsdom measures nothing, so every box gets a size and the rows draw.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 80, width: 300, height: 80, toJSON: () => ({}) });
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const existing = { id: "existing", path: "/existing.jsonl", title: "Existing thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 2 };

function start(overrides: { newSession?: (...args: unknown[]) => Promise<NewThreadResult> } = {}, storage = createMemoryStorage()) {
  const switchSession = vi.fn(async (): Promise<HostActionResult> => ({
    version: 1,
    updates: [{
      version: 1,
      type: "thread-detail",
      detail: { sessionId: "existing", messages: [{ id: "answer", role: "assistant", text: "Existing answer", timestamp: 1 }], isStreaming: false, activeTools: [] },
    }],
  }));
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [existing] },
      detail: { sessionId: "existing", messages: [{ id: "answer", role: "assistant", text: "Existing answer", timestamp: 1 }], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "existing", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/project" },
    }),
    invokeHostExtension: workspaceHostStub({
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
    }, { "tau.thread-titles": async () => undefined }),
    switchSession,
    ...(overrides.newSession ? { newSession: vi.fn(overrides.newSession) } : {}),
  });
  renderApp(client, { storage, extensions: [workspaceExtension] });
  return { client, switchSession, storage };
}

async function newThread(): Promise<HTMLTextAreaElement> {
  fireEvent.click(await screen.findByRole("button", { name: "New thread" }));
  const picker = await screen.findByRole("dialog", { name: "Search projects" });
  fireEvent.click(within(picker).getByRole("option", { name: /project/u }));
  return await screen.findByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
}

const rail = () => screen.getByRole("navigation", { name: "Threads" });
const draftRows = () => within(rail()).queryAllByRole("button", { name: /^Open draft / });
const openExisting = () => fireEvent.click(within(rail()).getByText("Existing thread"));

describe("draft rows in the rail", () => {
  it("shows a new thread as a draft from the moment it opens and names it by what is typed", async () => {
    start();
    await screen.findByText("Existing answer");
    expect(draftRows()).toHaveLength(0);

    const composer = await newThread();
    const row = await within(rail()).findByRole("button", { name: "Open draft New thread" });
    expect(row.getAttribute("aria-current")).toBe("true");
    // The thread the host holds behind the draft is not the active row.
    expect(rail().querySelectorAll(".thread-row.active:not(.thread-draft-row)")).toHaveLength(0);
    expect(within(row).getByText("Draft")).toBeTruthy();
    expect(within(row).getByText("project")).toBeTruthy();
    // At the top of the active threads.
    const cards = rail().querySelectorAll(".thread-row");
    expect(cards[0]?.classList.contains("thread-draft-row")).toBe(true);

    fireEvent.change(composer, { target: { value: "Fix the login bug\nwith details" } });
    expect(await within(rail()).findByRole("button", { name: "Open draft Fix the login bug" })).toBeTruthy();
  });

  it("drops a draft left empty and keeps one left with text, which opens again with its text", async () => {
    const { switchSession, storage } = start();
    await screen.findByText("Existing answer");

    await newThread();
    await within(rail()).findByRole("button", { name: "Open draft New thread" });
    openExisting();
    await waitFor(() => expect(switchSession).toHaveBeenCalled());
    await waitFor(() => expect(draftRows()).toHaveLength(0));

    const composer = await newThread();
    fireEvent.change(composer, { target: { value: "Keep this idea" } });
    openExisting();
    await waitFor(() => expect(switchSession).toHaveBeenCalledTimes(2));
    const kept = await within(rail()).findByRole("button", { name: "Open draft Keep this idea" });
    expect(kept.getAttribute("aria-current")).toBeNull();
    expect(JSON.parse(storage.get("tau.kept-drafts.v1") ?? "[]")).toMatchObject([{ draft: "Keep this idea", projectPath: "/project" }]);

    fireEvent.click(kept);
    await waitFor(() => expect((screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement).value).toBe("Keep this idea"));
    expect(within(rail()).getByRole("button", { name: "Open draft Keep this idea" }).getAttribute("aria-current")).toBe("true");
    expect(draftRows()).toHaveLength(1);
  });

  it("starts a fresh draft beside one with text, and discards a draft with its button", async () => {
    start();
    await screen.findByText("Existing answer");
    const composer = await newThread();
    fireEvent.change(composer, { target: { value: "First idea" } });
    await newThread();
    await waitFor(() => expect(draftRows().map((row) => row.getAttribute("aria-label"))).toEqual(["Open draft New thread", "Open draft First idea"]));
    expect((screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(within(rail()).getByRole("button", { name: "Discard draft First idea" }));
    await waitFor(() => expect(draftRows().map((row) => row.getAttribute("aria-label"))).toEqual(["Open draft New thread"]));
    // Discarding the draft on screen closes it onto the host's thread.
    fireEvent.click(within(rail()).getByRole("button", { name: "Discard draft New thread" }));
    await waitFor(() => expect(draftRows()).toHaveLength(0));
    expect(await screen.findByText("Existing answer")).toBeTruthy();
  });

  it("turns into the thread's own row with the first message, never both and never neither", async () => {
    let resolve!: (result: NewThreadResult) => void;
    let identity: { clientTurnId: string; clientMessageId: string } | undefined;
    start({
      newSession: (...args: unknown[]) => {
        identity = args[3] as typeof identity;
        return new Promise<NewThreadResult>((done) => { resolve = done; });
      },
    });
    await screen.findByText("Existing answer");
    const composer = await newThread();
    fireEvent.change(composer, { target: { value: "Count slowly" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(identity).toBeDefined());
    // On its way: still the draft, still titled by what was sent.
    expect(within(rail()).getByRole("button", { name: "Open draft Count slowly" })).toBeTruthy();
    expect(within(rail()).queryByText("Count slowly", { selector: ".thread-row:not(.thread-draft-row) .thread-title" })).toBeNull();

    const shell = { id: "created", path: "/created.jsonl", title: "Count slowly", modifiedAt: 2, projectPath: "/project", projectName: "project", messageCount: 1 };
    await act(async () => {
      resolve({
        version: 1,
        updates: [
          { version: 1, type: "thread-shell", update: { sessionId: "created", shell } },
          {
            version: 1,
            type: "thread-detail",
            detail: {
              sessionId: "created",
              messages: [{ id: "user", clientTurnId: identity!.clientTurnId, clientMessageId: identity!.clientMessageId, role: "user", text: "Count slowly", timestamp: 1 }],
              isStreaming: true,
              activeTools: [],
            },
          },
        ],
        sessionId: "created",
        submission: { accepted: true },
      } as NewThreadResult);
    });
    // The same commit that lists the thread takes the draft away.
    expect(draftRows()).toHaveLength(0);
    expect(within(rail()).getAllByText("Count slowly")).toHaveLength(1);
  });
});

describe("railDrafts", () => {
  const draft = (draftId: string, projectName: string, preview: string, sessionId?: string) => ({
    draftId, projectName, projectPath: `/${projectName}`, preview, attachments: 0, createdAt: 1, active: false, ...(sessionId ? { sessionId } : {}),
  });
  it("keeps the filtered project's drafts that match the search, and none whose thread is listed", () => {
    const drafts = [draft("a", "tau", "Fix the login"), draft("b", "other", "Fix the logout"), draft("c", "tau", "", "listed")];
    expect(railDrafts(drafts, { project: "tau" }).map((entry) => entry.draftId)).toEqual(["a", "c"]);
    expect(railDrafts(drafts, { query: "logout" }).map((entry) => entry.draftId)).toEqual(["b"]);
    expect(railDrafts(drafts, { query: "new thread" }).map((entry) => entry.draftId)).toEqual(["c"]);
    expect(railDrafts(drafts, { listed: new Set(["listed"]) }).map((entry) => entry.draftId)).toEqual(["a", "b"]);
  });
});
