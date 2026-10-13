// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { HostActionResult, ThreadDetail, TranscriptPage } from "../shared/host-protocol";
import type { WorkbenchActions } from "./extension-system";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { readBootstrapCache } from "../workbench/bootstrap-cache";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const detail = (sessionId: string, text: string): ThreadDetail => ({
  sessionId, messages: [{ id: `${sessionId}-message`, role: "assistant", text, timestamp: 1 }], isStreaming: false, activeTools: [],
});
const result = (sessionId: string, text: string): HostActionResult => ({
  version: 1, updates: [{ version: 1, type: "thread-detail", detail: detail(sessionId, text) }],
});
const sol = { provider: "openai", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5" };

async function start(waitForTranscript = true) {
  const responses = new Map<string, ReturnType<typeof deferred<HostActionResult>>>();
  const pages = new Map<string, ReturnType<typeof deferred<TranscriptPage>>>();
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [], sessions: ["a", "b", "c"].map((id) => ({ id, path: id, title: `Thread ${id}`, modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1,
        backendKind: id === "b" ? "claude-code" : "pi", modelProvider: id === "b" ? opus.provider : undefined, model: id === "b" ? opus.id : undefined,
      })) },
      detail: detail("a", "Original A"),
      catalog: { models: [sol, opus], model: sol, thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0,
        runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "claude-code", label: "Claude Code", homeProviders: ["anthropic"] }, { kind: "codex", label: "Codex", homeProviders: ["openai"] }],
      },
      project: { cwd: "/project" },
    }),
    switchSession: (path) => { const next = deferred<HostActionResult>(); responses.set(path, next); return next.promise; },
    loadTranscript: (id) => { const next = deferred<TranscriptPage>(); pages.set(id, next); return next.promise; },
  });
  let actions: WorkbenchActions | undefined;
  const rendered = renderApp(client, { extensions: [{ id: "test.navigation", name: "Navigation", activate(context) {
    context.registerRegion({ id: "capture", placement: "composer-above", Component: (props) => { actions = props.actions; return null; } });
  } }] });
  if (waitForTranscript) await screen.findByText("Original A");
  await waitFor(() => expect(actions?.activeThread()?.sessionId).toBe("a"));
  return { client, responses, pages, storage: rendered.storage, actions: () => actions! };
}

it("shows the selected thread's saved model while its runtime and transcript are stalled", async () => {
  const test = await start(false);
  await waitFor(() => expect(document.querySelector(".composer-model-chip")?.textContent).toContain(sol.name));
  act(() => { void test.actions().switchSession("b"); });
  await waitFor(() => expect(test.actions().activeThread()?.sessionId).toBe("b"));
  expect(document.querySelector(".composer-model-chip")?.textContent).toContain(opus.name);
  expect(document.querySelector(".composer-model-chip")?.textContent).not.toContain(sol.name);
  expect(document.querySelector(".composer-model-chip .provider-family-claude-code")).not.toBeNull();
  expect(document.querySelector(".composer-model-chip .provider-family-codex, .composer-model-chip .provider-family-openai")).toBeNull();
  await act(async () => {
    test.pages.get("b")!.resolve({ sessionId: "b", messages: detail("b", "Saved B").messages, hasMore: false });
  });
  await screen.findByText("Saved B");
  expect(document.querySelector(".composer-model-chip")?.textContent).toContain(opus.name);
  act(() => { test.client.emit({ type: "host-update", update: { version: 1, type: "catalog", catalog: {
    sessionId: "a", model: sol, models: [sol], thinkingLevel: "high", thinkingLevels: ["high"], allTools: [], extensionCount: 0,
  } } }); });
  expect(document.querySelector(".composer-model-chip")?.textContent).toContain(opus.name);
  await act(async () => {
    test.responses.get("b")!.resolve({ version: 1, updates: [
      { version: 1, type: "catalog", catalog: { sessionId: "b", backendKind: "claude-code", model: opus, models: [opus], thinkingLevel: "high", thinkingLevels: ["high"], allTools: [], extensionCount: 0 } },
      ...result("b", "Restored B").updates,
    ] });
  });
  await screen.findByText("Restored B");
  expect(document.querySelector(".composer-model-chip")?.textContent).toContain(opus.name);
  expect(readBootstrapCache(test.storage)?.snapshot.model).toEqual(opus);
  // Restart under load: the cached thread paints before bootstrap answers.
  cleanup();
  renderApp(createFakeHostClient({ bootstrap: () => deferred<never>().promise }), { storage: test.storage });
  await waitFor(() => expect(document.querySelector(".composer-model-chip")?.textContent).toContain(opus.name));
  expect(document.querySelector(".composer-model-chip")?.textContent).not.toContain(sol.name);
  expect(document.querySelectorAll(".composer-model-chip .provider-icon")).toHaveLength(1);
});

it("selects an uncached thread while its host and transcript requests are stalled", async () => {
  const test = await start();
  act(() => { void test.actions().switchSession("b"); });
  await waitFor(() => expect(test.actions().activeThread()?.sessionId).toBe("b"));
  await screen.findByRole("button", { name: "Thread b" });
  expect(screen.queryByText("Original A")).toBeNull();
  act(() => { void test.actions().switchSession("c"); });
  await waitFor(() => expect(test.actions().activeThread()?.sessionId).toBe("c"));
});

it.each([false, true])("keeps the selected thread after a switch timeout, with transcript loaded=%s", async (loaded) => {
  const test = await start();
  let selected!: Promise<boolean>;
  act(() => { selected = test.actions().switchSession("b"); });
  if (loaded) await act(async () => {
    test.pages.get("b")!.resolve({ sessionId: "b", messages: detail("b", "Saved B").messages, hasMore: false });
  });
  await act(async () => {
    test.responses.get("b")!.reject(new Error("timeout: request timed out after 30000ms"));
    expect(await selected).toBe(false);
  });
  await waitFor(() => expect(test.actions().activeThread()?.sessionId).toBe("b"));
  expect(screen.queryByText("Original A")).toBeNull();
  if (loaded) expect(screen.getByText("Saved B")).toBeTruthy();
  act(() => { test.client.emit({ type: "host-update", update: { version: 1, type: "thread-detail", detail: detail("a", "Unselected A") } }); });
  expect(test.actions().activeThread()?.sessionId).toBe("b");
  expect(screen.queryByText("Unselected A")).toBeNull();
});

it.each([false, true])("applies the switch response after a watched detail, with cached target=%s", async (cached) => {
  const test = await start();
  if (cached) {
    let initial!: Promise<boolean>;
    act(() => { initial = test.actions().switchSession("b"); });
    await act(async () => { test.responses.get("b")!.resolve(result("b", "Cached B")); await initial; });
    await screen.findByText("Cached B");
    act(() => { initial = test.actions().switchSession("a"); });
    await act(async () => { test.responses.get("a")!.resolve(result("a", "Original A")); await initial; });
    await screen.findByText("Original A");
  }
  let switched!: Promise<boolean>;
  act(() => { switched = test.actions().switchSession("b"); });
  act(() => { test.client.emit({ type: "host-update", update: { version: 1, type: "thread-detail", detail: detail("b", "Intermediate B") } }); });
  await screen.findByText("Intermediate B");
  await act(async () => { test.responses.get("b")!.resolve(result("b", "Restored B")); await switched; });
  await screen.findByText("Restored B");
  expect(screen.queryByText("Intermediate B")).toBeNull();
});

it("keeps the newest selection when earlier switch replies and previews arrive late", async () => {
  const test = await start();
  let first!: Promise<boolean>;
  let second!: Promise<boolean>;
  act(() => { first = test.actions().switchSession("b"); });
  act(() => { second = test.actions().switchSession("c"); });
  await act(async () => { test.responses.get("c")!.resolve(result("c", "Restored C")); await second; });
  await screen.findByText("Restored C");
  await act(async () => {
    test.pages.get("b")!.resolve({ sessionId: "b", messages: detail("b", "Late preview B").messages, hasMore: false });
    test.responses.get("b")!.resolve(result("b", "Late B"));
    await first;
  });
  expect(test.actions().activeThread()?.sessionId).toBe("c");
  expect(screen.getByText("Restored C")).toBeTruthy();
  expect(screen.queryByText("Late B")).toBeNull();
});

it("rejects an old reply even after returning to that same thread", async () => {
  const test = await start();
  let oldSwitch!: Promise<boolean>;
  act(() => { oldSwitch = test.actions().switchSession("b"); });
  const oldResponse = test.responses.get("b")!;
  act(() => { test.client.emit({ type: "host-update", update: { version: 1, type: "thread-detail", detail: detail("b", "Intermediate B") } }); });
  await screen.findByText("Intermediate B");
  for (const id of ["c", "b"]) {
    let selected!: Promise<boolean>;
    act(() => { selected = test.actions().switchSession(id); });
    await act(async () => { test.responses.get(id)!.resolve(result(id, `Current ${id}`)); await selected; });
    await screen.findByText(`Current ${id}`);
  }
  await act(async () => { oldResponse.resolve(result("b", "Obsolete B")); await oldSwitch; });
  expect(screen.getByText("Current b")).toBeTruthy();
  expect(screen.queryByText("Obsolete B")).toBeNull();
});

it("replaces a cached detail with a persisted page that is newer", async () => {
  const test = await start();
  let selected!: Promise<boolean>;
  act(() => { selected = test.actions().switchSession("b"); });
  await act(async () => { test.responses.get("b")!.resolve(result("b", "Question B")); await selected; });
  await screen.findByText("Question B");
  act(() => { selected = test.actions().switchSession("a"); });
  await act(async () => { test.responses.get("a")!.resolve(result("a", "Original A")); await selected; });
  await screen.findByText("Original A");

  // The thread answered while it was off screen; the host is still opening its runtime.
  act(() => { selected = test.actions().switchSession("b"); });
  await screen.findByText("Question B");
  await act(async () => {
    test.pages.get("b")!.resolve({ sessionId: "b", hasMore: false, messages: [
      ...detail("b", "Question B").messages,
      { id: "b-answer", role: "assistant", text: "Answer B", timestamp: 2 },
    ] });
  });
  await screen.findByText("Answer B");
  await act(async () => { test.responses.get("b")!.resolve(result("b", "Question B")); await selected; });
});

it("keeps a cached detail when the persisted page adds nothing", async () => {
  const test = await start();
  let selected!: Promise<boolean>;
  act(() => { selected = test.actions().switchSession("b"); });
  await act(async () => { test.responses.get("b")!.resolve(result("b", "Live B")); await selected; });
  act(() => { selected = test.actions().switchSession("a"); });
  await act(async () => { test.responses.get("a")!.resolve(result("a", "Original A")); await selected; });
  await screen.findByText("Original A");

  act(() => { selected = test.actions().switchSession("b"); });
  await screen.findByText("Live B");
  await act(async () => { test.pages.get("b")!.resolve({ sessionId: "b", hasMore: false, messages: detail("b", "Persisted B").messages }); });
  expect(screen.getByText("Live B")).toBeTruthy();
  expect(screen.queryByText("Persisted B")).toBeNull();
  await act(async () => { test.responses.get("b")!.resolve(result("b", "Live B")); await selected; });
});
