// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { renderApp } from "./test-support/render-app";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { writeBootstrapCache } from "../workbench/bootstrap-cache";
import { setHostClient } from "./host-client-context";
import type { HostBootstrap } from "../shared/contracts";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });
it("labels the saved chat unconfirmed until current startup data arrives", async () => {
  const storage = createMemoryStorage();
  const index = { projects: [], sessions: [{ id: "s", path: "s", title: "Old title", modifiedAt: 1, projectPath: "/p", projectName: "p", messageCount: 1 }] };
  writeBootstrapCache({ cwd: "/p", sessionId: "s", sessionTitle: "Old title", messages: [{ id: "u", role: "user", text: "Question", timestamp: 0 }, { id: "m", role: "assistant", text: "Old answer", timestamp: 1 }], models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], activeTools: [], extensionCount: 0, isStreaming: true }, index, storage);
  let resolve!: (value: HostBootstrap) => void;
  renderApp(createFakeHostClient({ bootstrap: () => new Promise(done => { resolve = done; }) }), { storage });
  await screen.findByText("Old answer");
  expect(document.querySelector("[data-content-freshness]")?.getAttribute("data-content-freshness")).toBe("loading");
  expect(screen.getByText(/Waiting for current messages and run status/)).toBeTruthy();
  await act(async () => resolve({ version: 1, threadIndex: index, detail: { sessionId: "s", messages: [{ id: "u", role: "user", text: "Question", timestamp: 0 }, { id: "m", role: "assistant", text: "Current answer", timestamp: 2 }], isStreaming: false, activeTools: [] }, catalog: { models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0 }, project: { cwd: "/p" } }));
  await screen.findByText("Current answer");
  expect(screen.queryByText("Old answer")).toBeNull();
  expect(document.querySelector("[data-content-freshness]")?.getAttribute("data-content-freshness")).toBe("current");
});

it("confirms navigation that supersedes a pending bootstrap without confirming its cached preview", async () => {
  const storage = createMemoryStorage();
  const sessions = ["s", "b"].map((id) => ({ id, path: id, title: id, modifiedAt: 1, projectPath: "/p", projectName: "p", messageCount: 1 }));
  const index = { projects: [], sessions };
  writeBootstrapCache({ cwd: "/p", sessionId: "s", sessionTitle: "s", models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0, messages: [{ id: "question", role: "user", text: "Question", timestamp: 0 }, { id: "old", role: "assistant", text: "Saved answer", timestamp: 1 }], isStreaming: false, activeTools: [] }, index, storage);
  let resolveBootstrap!: (value: HostBootstrap) => void;
  let resolveSwitch!: (value: import("../shared/host-protocol").HostActionResult) => void;
  let actions: import("./extension-system").WorkbenchActions | undefined;
  renderApp(createFakeHostClient({
    bootstrap: () => new Promise((resolve) => { resolveBootstrap = resolve; }),
    switchSession: () => new Promise((resolve) => { resolveSwitch = resolve; }),
    loadTranscript: () => new Promise(() => {}),
  }), { storage, extensions: [{ id: "test.capture", name: "Capture", activate(context) {
    context.registerRegion({ id: "capture", placement: "composer-above", Component: (props) => { actions = props.actions; return null; } });
  } }] });
  await screen.findByText("Saved answer");
  await waitFor(() => expect(actions).toBeDefined());
  act(() => { void actions!.switchSession("b"); });
  await act(async () => resolveBootstrap({ version: 1, threadIndex: index, detail: { sessionId: "s", messages: [], isStreaming: false, activeTools: [] }, catalog: { models: [], thinkingLevel: "off", thinkingLevels: [], allTools: [], extensionCount: 0 }, project: { cwd: "/p" } }));
  expect(document.querySelector("[data-content-freshness]")?.getAttribute("data-content-freshness")).toBe("loading");
  await act(async () => resolveSwitch({ version: 1, updates: [{ version: 1, type: "thread-detail", detail: { sessionId: "b", messages: [{ id: "new", role: "assistant", text: "Confirmed B", timestamp: 1 }], isStreaming: false, activeTools: [] } }] }));
  await screen.findByText("Confirmed B");
  expect(document.querySelector("[data-content-freshness]")?.getAttribute("data-content-freshness")).toBe("current");
});
