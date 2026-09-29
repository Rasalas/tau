// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewThreadResult } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { RAIL_GROUPING_OPTION } from "./rail-order.js";
import { WORKSPACE_HOST_EXTENSION_ID } from "./protocol.js";

// The main list is virtual; jsdom measures nothing, so every box gets a size and the rows draw.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 80, width: 300, height: 80, toJSON: () => ({}) });
});
afterEach(() => { vi.restoreAllMocks(); cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const luna = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
const thread = { id: "alpha-thread", path: "/alpha-thread.jsonl", title: "Alpha work", modifiedAt: 1, projectPath: "/alpha", projectName: "alpha", messageCount: 2 };
const betaThread = { id: "beta-thread", path: "/beta-thread.jsonl", title: "Beta work", modifiedAt: 2, projectPath: "/beta", projectName: "beta", messageCount: 2 };

const catalog = {
  sessionId: thread.id,
  backendKind: "codex",
  runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex", modes: ["plan"] }],
  defaultBackendKind: "pi",
  models: [luna],
  model: luna,
  thinkingLevel: "high",
  thinkingLevels: ["low", "high"],
  mode: "plan",
  modes: ["plan"],
  allTools: [],
  extensionCount: 0,
  supportsImageInput: true,
};

/** A Codex thread in `alpha` on screen, in plan mode on Luna at a high level; `beta` is where the host last worked. */
function start(options: { grouped?: boolean } = {}) {
  const newSession = vi.fn(async (..._args: unknown[]): Promise<NewThreadResult> => ({ version: 1, updates: [], submission: { accepted: true } }));
  const preparePrompt = vi.fn(async (..._args: unknown[]) => undefined);
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: {
        projects: [{ path: "/alpha", name: "alpha", lastOpenedAt: 1 }, { path: "/beta", name: "beta", lastOpenedAt: 50 }],
        sessions: [thread, betaThread],
      },
      detail: { sessionId: thread.id, backendKind: "codex", messages: [{ id: "answer", role: "assistant", text: "Alpha answer", timestamp: 1 }], isStreaming: false, activeTools: [] },
      catalog,
      project: { cwd: "/alpha" },
    }),
    invokeHostExtension: workspaceHostStub({
      listEditors: async () => [],
      getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async (cwd?: string) => ({ root: cwd ?? "/alpha", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
      getFileTree: async () => [],
    }, { "tau.thread-titles": async () => undefined }),
    newSession,
    preparePrompt,
  });
  const view = renderApp(client, {
    extensions: [workspaceExtension],
    ...(options.grouped ? { seed: ({ preferences }) => preferences.setValue(WORKSPACE_HOST_EXTENSION_ID, RAIL_GROUPING_OPTION, "repository") } : {}),
  });
  return { client, newSession, preparePrompt, preferences: view.services.preferences };
}

function press(key: string, shiftKey = false): void {
  const mac = /mac|iphone|ipad/iu.test(navigator.platform);
  fireEvent.keyDown(window, { key, metaKey: mac, ctrlKey: !mac, shiftKey, bubbles: true, cancelable: true });
}

const rail = () => screen.getByRole("navigation", { name: "Threads" });
const draftProject = () => screen.findByRole("button", { name: /^Change project, current project / });
const composer = () => screen.getByPlaceholderText(/Ask anything/u) as HTMLTextAreaElement;

describe("a new thread in the project on screen", () => {
  it("opens from ⌘N and the rail's button in the thread's project, without the picker", async () => {
    start();
    await screen.findByText("Alpha answer");
    press("n");
    expect((await draftProject()).getAttribute("aria-label")).toBe("Change project, current project alpha");
    expect(screen.queryByRole("dialog", { name: "Search projects" })).toBeNull();

    // From the draft, the rail's button stays in the draft's project.
    fireEvent.change(composer(), { target: { value: "Keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    await waitFor(() => expect(composer().value).toBe(""));
    expect((await draftProject()).getAttribute("aria-label")).toBe("Change project, current project alpha");
    // The draft with text stays a row beside the fresh one.
    await waitFor(() => expect(within(rail()).getAllByRole("button", { name: /^Open draft / }).map((row) => row.getAttribute("aria-label")))
      .toEqual(["Open draft New thread", "Open draft Keep me"]));
    expect(screen.queryByRole("dialog", { name: "Search projects" })).toBeNull();
  });

  it("starts on the thread's runtime, model, level and mode, and leaves the preference for new threads alone", async () => {
    const { client, newSession, preparePrompt, preferences } = start();
    await screen.findByText("Alpha answer");
    // The host sends its catalog again once connected; the thread's mode arrives with it.
    act(() => client.emit({ type: "host-update", update: { version: 1, type: "catalog", catalog } }));
    press("n");
    await draftProject();
    fireEvent.change(composer(), { target: { value: "carry on" } });
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(newSession).toHaveBeenCalledWith(
      "carry on",
      [],
      "/alpha",
      expect.objectContaining({ clientMessageId: expect.any(String) }),
      undefined,
      { model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "high", mode: "plan" },
    ));
    expect(preparePrompt).toHaveBeenCalledWith("carry on", undefined, undefined, "codex");
    expect(preferences.getSnapshot().newThreadRuntime).toBeUndefined();
  });

  it("asks for the project with ⇧⌘O", async () => {
    start();
    await screen.findByText("Alpha answer");
    press("O", true);
    const picker = await screen.findByRole("dialog", { name: "Search projects" });
    fireEvent.click(within(picker).getByRole("option", { name: /beta/u }));
    expect((await draftProject()).getAttribute("aria-label")).toBe("Change project, current project beta");
    // ⌘N from that draft stays in beta.
    fireEvent.change(composer(), { target: { value: "Beta idea" } });
    press("n");
    await waitFor(() => expect(composer().value).toBe(""));
    expect((await draftProject()).getAttribute("aria-label")).toBe("Change project, current project beta");
  });

  it("opens in a project heading's own project from its button", async () => {
    start({ grouped: true });
    await screen.findByText("Alpha answer");
    fireEvent.click(await within(rail()).findByRole("button", { name: "New thread in beta" }));
    expect((await draftProject()).getAttribute("aria-label")).toBe("Change project, current project beta");
    fireEvent.click(within(rail()).getByRole("button", { name: "New thread in alpha" }));
    await waitFor(async () => expect((await draftProject()).getAttribute("aria-label")).toBe("Change project, current project alpha"));
  });

  it("opens where the host last worked while Settings covers the thread", async () => {
    start();
    await screen.findByText("Alpha answer");
    press(",");
    await screen.findByRole("dialog", { name: "Settings" });
    press("n");
    expect((await draftProject()).getAttribute("aria-label")).toBe("Change project, current project beta");
    // The draft is not left behind Settings.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  });
});
