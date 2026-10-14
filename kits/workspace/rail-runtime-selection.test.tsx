// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostActionResult, UiMessage, UiRuntimeCatalog } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { readNewThreadDraft, setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); setHostClient(undefined); setClientStorage(undefined); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("opens an uncached Pi thread from the rail when Pi is signed out and Codex is ready", async () => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(768);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1024);
  const project = { path: "/project", name: "project", lastOpenedAt: 1 };
  const saved = { id: "saved", path: "/saved.jsonl", title: "Saved Pi work", modifiedAt: 1, projectPath: project.path, projectName: project.name, messageCount: 2, backendKind: "pi" };
  const model = { provider: "openai", id: "one", name: "One" };
  const catalogs: UiRuntimeCatalog[] = [
    { kind: "pi", models: [], status: "sign-in-required", thinkingLevels: {} },
    { kind: "codex", models: [model], model, thinkingLevels: {} },
  ];
  const messages: UiMessage[] = [{ id: "saved-message", role: "user", text: "Saved Pi message", timestamp: 1 }];
  const page = deferred<{ sessionId: string; messages: UiMessage[]; hasMore: boolean }>();
  const response = deferred<HostActionResult>();
  const loadTranscript = vi.fn(() => page.promise);
  const switchSession = vi.fn(() => response.promise);
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [project], sessions: [saved] },
      detail: { sessionId: "startup", messages: [], isStreaming: false, activeTools: [] },
      catalog: {
        sessionId: "startup", backendKind: "pi", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0,
        runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }],
      },
      project: { cwd: project.path },
    }),
    runtimeCatalogs: async () => catalogs,
    runtimeCatalog: async (kind) => catalogs.find((catalog) => catalog.kind === kind),
    loadTranscript, switchSession,
    invokeHostExtension: workspaceHostStub({
      listEditors: async () => [], getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: project.path, isRepo: true, isDirty: false, worktrees: [], refs: [] }), getFileTree: async () => [],
    }),
  });
  const { storage } = renderApp(client, { extensions: [workspaceExtension] });
  await screen.findByRole("button", { name: /^Select runtime and model: One/ });
  await waitFor(() => expect(readNewThreadDraft(storage)).toBeDefined());
  const rail = await screen.findByRole("navigation", { name: "Threads" });
  const title = await within(rail).findByText(saved.title);
  const row = title.closest(".thread-row")!;
  await act(async () => { fireEvent.click(title); });
  expect(switchSession).toHaveBeenCalledWith(saved.path);
  expect(loadTranscript).toHaveBeenCalledWith(saved.id);
  await waitFor(() => {
    expect(readNewThreadDraft(storage)).toBeUndefined();
    expect(row.querySelector(".thread-main")?.getAttribute("aria-current")).toBe("page");
  });

  // Persisted history arrives before the runtime finishes opening.
  await act(async () => { page.resolve({ sessionId: saved.id, messages, hasMore: false }); });
  await screen.findByText("Saved Pi message");
  expect(readNewThreadDraft(storage)).toBeUndefined();
  await act(async () => {
    response.resolve({ version: 1, updates: [
      { version: 1, type: "thread-detail", detail: { sessionId: saved.id, backendKind: "pi", messages, isStreaming: false, activeTools: [] } },
    ] });
  });
  await waitFor(() => {
    expect(screen.getByText("Saved Pi message")).toBeTruthy();
    expect(readNewThreadDraft(storage)).toBeUndefined();
    expect(row.querySelector(".thread-main")?.getAttribute("aria-current")).toBe("page");
  });
});
