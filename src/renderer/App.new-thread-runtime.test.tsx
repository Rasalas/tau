// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UiRuntimeCatalog } from "../shared/contracts";
import type { HostClient } from "../workbench/host-client";
import { PI_AGENT_RUNTIME_ADAPTER } from "../main/runtime-adapters";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { readNewThreadDraft } from "../workbench/draft-store";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { workspaceHostStub } from "./test-support/workspace-host-stub";

const model = { provider: "acme", id: "one", name: "Acme One" };
afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

/** A host with Pi (no provider yet) and a second runtime whose catalog `acme` says. */
function hostWith(acme: Omit<UiRuntimeCatalog, "kind" | "thinkingLevels">) {
  const project = { path: "/project", name: "project", lastOpenedAt: 1 };
  const catalogs: UiRuntimeCatalog[] = [
    { kind: "pi", models: [], thinkingLevels: {} },
    { kind: "acme", thinkingLevels: {}, ...acme },
  ];
  const preparePrompt = vi.fn<HostClient["preparePrompt"]>(async (text, _session, _skill, backend) => ({
    backendKind: backend ?? "pi", runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities, visibleText: text, runtimeText: text, sourceFingerprint: "first-start",
  }));
  const newSession = vi.fn<HostClient["newSession"]>(async () => ({ version: 1, sessionId: "created", submission: { accepted: true }, updates: [] }));
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [project], sessions: [] },
      detail: { sessionId: "startup", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "startup", backendKind: "pi", runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme" }], models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: "/project" },
    }),
    runtimeCatalogs: async () => catalogs,
    runtimeCatalog: async (kind) => catalogs.find((catalog) => catalog.kind === kind),
    newSession, preparePrompt,
    invokeHostExtension: workspaceHostStub({
      listEditors: async () => [], getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: true, isDirty: false, worktrees: [], refs: [] }), getFileTree: async () => [],
    }),
  });
  return { client, preparePrompt, newSession };
}

it("starts a first thread on the one runtime that is ready, though Pi has no provider", async () => {
  const { client, preparePrompt, newSession } = hostWith({ models: [model], model });
  const { storage } = renderApp(client);
  await screen.findByRole("heading", { name: /do next\?$/ });
  // What is typed on the start screen goes to the thread on screen, which is Pi's: a draft on the ready runtime takes its place.
  await waitFor(() => expect(readNewThreadDraft(storage)).toBeDefined());
  expect(await screen.findByRole("button", { name: /^Select runtime and model: Acme/ })).toBeTruthy();
  expect(screen.queryByText("No provider is set up yet")).toBeNull();
  const composer = screen.getByPlaceholderText(/Ask anything/);
  fireEvent.change(composer, { target: { value: "hello" } });
  fireEvent.keyDown(composer, { key: "Enter" });
  await waitFor(() => expect(newSession).toHaveBeenCalledWith("hello", [], "/project", expect.anything(), expect.objectContaining({ backendKind: "acme" })));
  expect(preparePrompt).toHaveBeenCalledWith("hello", undefined, undefined, "acme", "/project");
});

it("holds the first prompt back and leads to Providers while no runtime is set up", async () => {
  const { client, preparePrompt, newSession } = hostWith({ models: [], status: "sign-in-required", note: "Acme is not signed in." });
  const view = renderApp(client);
  await screen.findByRole("heading", { name: /do next\?$/ });
  expect(await screen.findByText("No provider is set up yet")).toBeTruthy();
  const composer = screen.getByPlaceholderText(/Ask anything/);
  fireEvent.change(composer, { target: { value: "hello" } });
  fireEvent.keyDown(composer, { key: "Enter" });
  expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Open Runtimes" }));
  // Settings is a lazy chunk; its frame is there as soon as the page was asked for.
  await waitFor(() => expect(view.container.querySelector(".settings-screen")).not.toBeNull());
  expect(preparePrompt).not.toHaveBeenCalled();
  expect(newSession).not.toHaveBeenCalled();
});
