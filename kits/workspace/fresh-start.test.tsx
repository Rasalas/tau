// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiRuntimeCatalog } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { createMemoryStorage, readNewThreadDraft, setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";

afterEach(() => {
  cleanup(); setHostClient(undefined); setClientStorage(undefined);
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

interface Start {
  isRepo: boolean;
  messageCount: number;
  /** More the window's workspace info says, as a private "No project" folder does. */
  info?: Record<string, unknown>;
  /** Whether the start folder is already a listed project. */
  listed?: boolean;
  privateWorkspace?: boolean;
  /** The runtimes the host offers and what each one's catalog says; absent: Pi alone, with the model above. */
  runtimes?: Array<{ backend: { kind: string; label: string }; catalog?: Omit<UiRuntimeCatalog, "kind" | "thinkingLevels"> }>;
}

/** A window on the host's startup session or its private workspace. */
function start({ isRepo, messageCount, info, listed = true, privateWorkspace = false, runtimes }: Start) {
  const scratchPath = "/state/scratch/3445961b-07a0-49eb-bcb5-36e722c37630";
  let scratchOpened = privateWorkspace;
  const scratchThread = { id: "scratch", path: "/scratch.jsonl", title: "New thread", modifiedAt: 2, projectPath: scratchPath, workspaceId: "ws:scratch", projectName: "No project", projectless: true, messageCount: privateWorkspace ? messageCount : 0 };
  const openProject = vi.fn(async () => {
    scratchOpened = true;
    return { version: 1 as const, updates: [
      { version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [scratchThread] } },
      { version: 1 as const, type: "thread-detail" as const, detail: { sessionId: "scratch", messages: [], isStreaming: false, activeTools: [] } },
      { version: 1 as const, type: "project" as const, project: { cwd: scratchPath, workspaceId: "ws:scratch" } },
    ] };
  });
  const createScratch = vi.fn(async () => ({ workspaceId: "ws:scratch", displayPath: scratchPath }));
  const getWorkspaceInfo = vi.fn(async () => scratchOpened
    ? { root: scratchPath, isRepo: false, isDirty: false, worktrees: [], refs: [], projectless: true }
    : { root: "/home/me", isRepo, isDirty: false, worktrees: [], refs: [], ...info });
  const runtimeCatalogs = vi.fn(async () => (runtimes ?? []).flatMap(({ backend, catalog }) => catalog ? [{ kind: backend.kind, thinkingLevels: {}, ...catalog }] : []));
  const newSession = vi.fn(async () => ({ version: 1 as const, updates: [], submission: { accepted: true as const } }));
  const model = { provider: "anthropic", id: "haiku", name: "Haiku" };
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: {
        projects: listed && !privateWorkspace ? [{ path: "/home/me", name: "me", lastOpenedAt: 1 }] : [],
        sessions: privateWorkspace ? [scratchThread] : [{ id: "start", path: "/start.jsonl", title: "New thread", modifiedAt: 1, projectPath: "/home/me", projectName: "me", messageCount }],
      },
      detail: { sessionId: privateWorkspace ? "scratch" : "start", messages: privateWorkspace && messageCount > 0 ? [{ id: "first", role: "user" as const, text: "Hello", timestamp: 3 }] : [], isStreaming: false, activeTools: [] },
      catalog: {
        sessionId: privateWorkspace ? "scratch" : "start", models: runtimes ? runtimes.find(({ backend }) => backend.kind === "pi")?.catalog?.models ?? [] : [model], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true,
        ...(runtimes ? { backendKind: "pi", runtimeBackends: runtimes.map((runtime) => runtime.backend) } : {}),
      },
      project: privateWorkspace ? { cwd: scratchPath, workspaceId: "ws:scratch" } : { cwd: "/home/me" },
    }),
    runtimeCatalogs,
    runtimeCatalog: async (kind) => (await runtimeCatalogs()).find((catalog) => catalog.kind === kind),
    newSession,
    openProject,
    invokeHostExtension: workspaceHostStub({
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo,
      getFileTree: async () => [],
      createScratch,
    }),
  });
  const { storage } = renderApp(client, { storage: createMemoryStorage(), extensions: [workspaceExtension] });
  return { openProject, createScratch, getWorkspaceInfo, runtimeCatalogs, newSession, storage };
}

describe("a fresh install (2a)", () => {
  it.each(["pi", "acme"])("shows the start page with only %s ready, then opens a draft on it", async (kind) => {
    const model = { provider: kind, id: "one", name: "One" };
    const { storage } = start({
      isRepo: false, messageCount: 0,
      runtimes: [
        { backend: { kind: "pi", label: "Pi" }, catalog: { models: kind === "pi" ? [model] : [] } },
        { backend: { kind: "acme", label: "Acme" }, catalog: kind === "acme" ? { models: [model], model } : { models: [], status: "sign-in-required" } },
      ],
    });
    // Wait for the automatic replacement of the empty Pi thread before checking the page.
    if (kind === "acme") await waitFor(() => expect(readNewThreadDraft(storage)).toBeDefined());
    await screen.findByRole("heading", { name: "Open a project to start" });
    await waitFor(() => expect(document.querySelector(".fresh-start-providers")?.textContent).toContain("connected · add more"));
    expect(screen.getByRole("button", { name: "Start without a project" })).toBeTruthy();
    const initialDraft = readNewThreadDraft(storage)?.draftId;
    fireEvent.click(await within((await screen.findByRole("navigation", { name: "Threads" })).closest("aside")!).findByRole("button", { name: "New thread" }));
    await waitFor(() => {
      expect(readNewThreadDraft(storage)?.draftId).toBeDefined();
      expect(readNewThreadDraft(storage)?.draftId).not.toBe(initialDraft);
      expect(screen.queryByRole("heading", { name: "Open a project to start" })).toBeNull();
    });
    await waitFor(() => expect(readNewThreadDraft(storage)?.runtime).toBe(kind));
    expect(await screen.findByRole("button", { name: /^Select runtime and model:/ })).toBeTruthy();
  });

  it("keeps the setup guidance when no runtime is ready", async () => {
    const { storage, newSession } = start({
      isRepo: false, messageCount: 0,
      runtimes: [
        { backend: { kind: "pi", label: "Pi" }, catalog: { models: [] } },
        { backend: { kind: "acme", label: "Acme" }, catalog: { models: [], status: "sign-in-required" } },
      ],
    });
    await screen.findByRole("heading", { name: "Open a project to start" });
    await waitFor(() => expect(document.querySelector(".fresh-start-providers")?.textContent).toBe("No agent is set up yet · set one up"));
    expect(readNewThreadDraft(storage)).toBeUndefined();
    expect(newSession).not.toHaveBeenCalled();
  });

  it("asks for a project in place of the draft, with the chords and the connected providers", async () => {
    start({ isRepo: false, messageCount: 0 });
    expect(await screen.findByRole("heading", { name: "Open a project to start" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open a folder" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clone a repository" })).toBeTruthy();
    expect(document.querySelector(".fresh-start-keys")?.textContent).toContain("new thread");
    await waitFor(() => expect(document.querySelector(".fresh-start-providers")?.textContent).toContain("Anthropic connected · add more"));
    // The rail says the same: nothing yet.
    expect(document.querySelector(".sidebar-empty.first")?.textContent).toBe("No threads yet.They’ll line up here.");
  });

  it("gives way to the draft once the new-thread chord opened one", async () => {
    start({ isRepo: false, messageCount: 0 });
    await screen.findByRole("heading", { name: "Open a project to start" });
    fireEvent.click(await within((await screen.findByRole("navigation", { name: "Threads" })).closest("aside")!).findByRole("button", { name: "New thread" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Open a project to start" })).toBeNull());
  });

  it("starts a thread in a private folder without a project, in one click", async () => {
    const { createScratch, openProject } = start({ isRepo: false, messageCount: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "Start without a project" }));
    await waitFor(() => expect(openProject).toHaveBeenCalledWith("ws:scratch"));
    expect(createScratch).toHaveBeenCalledTimes(1);
    const heading = await screen.findByRole("heading", { name: "What should we do next?" });
    expect(within(heading.parentElement!).getByRole("button", { name: "Change project, current project No project" })).toBeTruthy();
  });

  it("does not ask for a project in the private folder it started in", async () => {
    const { getWorkspaceInfo } = start({ isRepo: false, messageCount: 0, info: { projectless: true } });
    await waitFor(() => expect(getWorkspaceInfo).toHaveBeenCalled());
    await act(async () => undefined);
    expect(document.querySelector(".fresh-start")).toBeNull();
  });

  it("uses the same private workspace name on a phone", async () => {
    window.history.replaceState({}, "", "/?profile=compact&thread=scratch");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    start({ isRepo: false, messageCount: 0, privateWorkspace: true });
    const heading = await screen.findByRole("heading", { name: "What should we build?" });
    const picker = within(heading.parentElement!).getByRole("button", { name: "Change project, current project No project" });
    expect(heading.contains(picker)).toBe(false);
    expect(picker.classList.contains("draft-pill")).toBe(true);
    fireEvent.click(picker);
    expect(await screen.findByRole("dialog", { name: "Choose project" })).toBeTruthy();
  });

  it("reopens an empty private workspace without its project name in the heading", async () => {
    start({ isRepo: false, messageCount: 0, privateWorkspace: true });
    const heading = await screen.findByRole("heading", { name: "What should we do next?" });
    const picker = within(heading.parentElement!).getByRole("button", { name: "Change project, current project No project" });
    expect(within(picker).getByText("No project")).toBeTruthy();
  });

  it("names a reopened private workspace in the thread header and sidebar", async () => {
    // Give the virtual thread list a viewport in jsdom.
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(768);
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1024);
    try {
      start({ isRepo: false, messageCount: 1, privateWorkspace: true });
      expect(await screen.findByRole("button", { name: "New thread in No project" })).toBeTruthy();
      await waitFor(() => expect(document.querySelector(".session-rail")?.textContent).toContain("No project"));
    } finally { height.mockRestore(); width.mockRestore(); }
  });

  it("calls any folder a project, as the folder picker does", async () => {
    start({ isRepo: false, messageCount: 0 });
    await screen.findByRole("heading", { name: "Open a project to start" });
    expect(document.querySelector(".fresh-start-lede")?.textContent).toBe("A project is any folder on this machine. A git repo adds worktrees and reviews.");
  });

  it("names the runtimes that are ready, not the models Pi lists", async () => {
    start({
      isRepo: false,
      messageCount: 0,
      listed: false,
      runtimes: [
        { backend: { kind: "pi", label: "Pi" }, catalog: { models: [] } },
        { backend: { kind: "acme", label: "Acme" }, catalog: { models: [{ provider: "acme", id: "one", name: "One" }] } },
      ],
    });
    await screen.findByRole("heading", { name: "Open a project to start" });
    await waitFor(() => expect(document.querySelector(".fresh-start-providers > span:last-child")?.textContent).toBe("Acme connected · add more"));
  });

  it("says no agent is set up once every runtime has answered, and not before", async () => {
    const { runtimeCatalogs } = start({
      isRepo: false,
      messageCount: 0,
      listed: false,
      runtimes: [
        { backend: { kind: "pi", label: "Pi" }, catalog: { models: [] } },
        { backend: { kind: "acme", label: "Acme" }, catalog: { models: [], status: "sign-in-required", note: "Sign in first." } },
        { backend: { kind: "other", label: "Other" } },
      ],
    });
    await screen.findByRole("heading", { name: "Open a project to start" });
    // Another runtime has not answered: the row does not claim there is nothing.
    await waitFor(() => expect(runtimeCatalogs).toHaveBeenCalled());
    await act(async () => undefined);
    expect(document.querySelector(".fresh-start-providers")).toBeNull();
    cleanup();
    start({
      isRepo: false,
      messageCount: 0,
      listed: false,
      runtimes: [
        { backend: { kind: "pi", label: "Pi" }, catalog: { models: [] } },
        { backend: { kind: "acme", label: "Acme" }, catalog: { models: [], status: "sign-in-required", note: "Sign in first." } },
      ],
    });
    await waitFor(() => expect(document.querySelector(".fresh-start-providers > span:last-child")?.textContent).toBe("No agent is set up yet · set one up"));
  });

  it("stays out of a repository and of a window that already has a thread", async () => {
    start({ isRepo: true, messageCount: 0 });
    expect(await screen.findByRole("heading", { name: /What should .+ do next\?/u })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".fresh-start")).toBeNull();
    cleanup();
    start({ isRepo: false, messageCount: 2 });
    await waitFor(() => expect(document.querySelector(".thread-title-trigger")?.textContent).toContain("New thread"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.querySelector(".fresh-start")).toBeNull();
  });
});
