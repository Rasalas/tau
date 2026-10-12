// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { HostClient } from "../workbench/host-client";
import type { DesktopExtension } from "./extension-system";
import { PI_AGENT_RUNTIME_ADAPTER } from "../main/runtime-adapters";
import { setHostClient } from "./host-client-context";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { writeNewThreadDraft } from "../workbench/draft-store";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { workspaceHostStub } from "./test-support/workspace-host-stub";

const old = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
const selected = { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

it.each([
  { explicit: false, runtime: "codex", label: "Codex" },
  { explicit: true, runtime: "codex", label: "Codex" },
  { explicit: false, runtime: "pi", label: "Pi" },
  { explicit: true, runtime: "pi", label: "Pi" },
])("keeps $label and the selected model through launch and hydration, explicit draft=$explicit", async ({ explicit, runtime, label }) => {
  const project = { path: "/project", name: "project", lastOpenedAt: 1 };
  const capabilities = PI_AGENT_RUNTIME_ADAPTER.capabilities;
  const preparePrompt = vi.fn<HostClient["preparePrompt"]>(async (text, _session, _skill, backend) => ({
    backendKind: backend ?? "pi", runtimeCapabilities: capabilities, visibleText: text, runtimeText: text, sourceFingerprint: "selected-model",
  }));
  const newSession = vi.fn<HostClient["newSession"]>(async (text, _attachments, _cwd, identity, prepared, configuration) => ({
    version: 1, sessionId: "created", submission: { accepted: true },
    updates: [
      { version: 1, type: "thread-index", index: { projects: [project], sessions: [{ id: "created", path: "/created", title: "Untitled thread", modifiedAt: 1, projectPath: project.path, projectName: project.name, messageCount: 1 }] } },
      { version: 1, type: "thread-detail", detail: { sessionId: "created", messages: [{ id: "first", role: "user", text: text!, timestamp: Date.now(), ...(typeof identity === "object" ? identity : {}) }], isStreaming: false, activeTools: [] } },
      { version: 1, type: "catalog", catalog: { sessionId: "created", backendKind: prepared!.backendKind, models: [old, selected], model: { ...selected, ...configuration?.model }, thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, runtimeCapabilities: capabilities } },
    ],
  }));
  const setModel = vi.fn(async () => ({ version: 1 as const, updates: [] as never[] }));
  const catalogs = [
    { kind: "pi", models: [old, selected], model: old, thinkingLevels: {} },
    { kind: "codex", models: [selected], model: selected, thinkingLevels: {} },
  ];
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [] },
      detail: { sessionId: "startup", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "startup", backendKind: "pi", runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }], models: [old, selected], model: old, thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: "/project" },
    }),
    runtimeCatalogs: async () => catalogs,
    runtimeCatalog: async (kind) => catalogs.find((catalog) => catalog.kind === kind),
    newSession, setModel, preparePrompt,
    invokeHostExtension: workspaceHostStub({
      listEditors: async () => [], getChanges: async () => ({ files: [], added: 0, removed: 0 }),
      getWorkspaceInfo: async () => ({ root: "/project", isRepo: true, isDirty: false, worktrees: [], refs: [] }), getFileTree: async () => [],
    }),
  });
  const storage = createMemoryStorage();
  if (explicit) writeNewThreadDraft(storage, { kind: "draft", draftId: "explicit", projectPath: "/project", projectName: "project" });
  const controls: DesktopExtension = { id: "test.device", name: "Device control", activate: (context) => {
    context.registerRegion({ id: "device", placement: "draft-actions", Component: () => <button type="button">Change device</button> });
  } };
  const view = renderApp(client, { storage, extensions: [controls] });
  await screen.findByRole("heading", { name: /do next\?$/ });
  fireEvent.click(await screen.findByRole("button", { name: "Select runtime and model: GPT-5.6 Sol" }));
  const picker = await screen.findByRole("dialog", { name: "Select model" });
  fireEvent.click(await within(picker).findByRole("radio", { name: label }));
  fireEvent.click(await within(picker).findByRole("option", { name: new RegExp(`^GPT-6.1 Sol, ${label}`) }));
  expect(await screen.findByRole("button", { name: /Select (runtime and )?model: GPT-6.1 Sol/ })).toBeTruthy();
  expect(screen.getByRole("img", { name: new RegExp(`GPT-6.1 Sol · ${label}`) })).toBeTruthy();
  expect(setModel).not.toHaveBeenCalled();
  const header = view.container.querySelector(".thread-header")!;
  expect(within(header as HTMLElement).getByRole("navigation", { name: "Thread breadcrumb" })).toBeTruthy();
  expect(header.textContent).toContain("Untitled thread");
  expect(header.querySelector(".thread-details")).toBeNull();
  expect(screen.getByRole("button", { name: "Change project, current project project" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change device" })).toBeTruthy();
  const headerStructure = () => [...header.querySelectorAll(":scope > *, .thread-heading *")].map((node) => [node.tagName, node.getAttribute("class")]);
  const before = headerStructure();
  const composer = screen.getByPlaceholderText(/Ask anything/);
  fireEvent.change(composer, { target: { value: "launch selected model" } });
  fireEvent.keyDown(composer, { key: "Enter" });
  await waitFor(() => expect(newSession).toHaveBeenCalledWith("launch selected model", [], "/project", expect.anything(), expect.objectContaining({ backendKind: runtime }),
    { model: { provider: "openai-codex", id: "gpt-6.1-sol" } }));
  expect(preparePrompt).toHaveBeenCalledWith("launch selected model", undefined, undefined, runtime, "/project");
  await waitFor(() => expect(screen.queryByRole("heading", { name: /do next\?$/ })).toBeNull());
  expect((await screen.findByRole("button", { name: "Select model: GPT-6.1 Sol" })).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("img", { name: new RegExp(`GPT-6.1 Sol · ${label}`) })).toBeTruthy();
  expect(headerStructure()).toEqual(before);
  expect(screen.queryByRole("button", { name: "Change device" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Change project, current project project" })).toBeNull();
});
