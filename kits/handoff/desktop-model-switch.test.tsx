// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setHostClient } from "../../src/renderer/host-client-context.js";
import { setClientStorage } from "../../src/workbench/client-storage.js";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { createHandoffExtension } from "./desktop.js";
import { HandoffStore } from "./store.js";
import type { HostClient } from "../../src/workbench/host-client.js";
import { PI_AGENT_RUNTIME_ADAPTER } from "../../src/main/runtime-adapters.js";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

it("switches a limited Pi thread from Opus to Sol and sends its next message with that selection", async () => {
  const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Opus 5.5" };
  const sol = { provider: "openai-codex", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
  const catalog = { sessionId: "limited", backendKind: "pi", models: [opus, sol], model: opus, thinkingLevel: "high", thinkingLevels: ["high"], allTools: [], extensionCount: 0 };
  const setModel = vi.fn(async () => ({ version: 1 as const, updates: [{ version: 1 as const, type: "catalog" as const, catalog: { ...catalog, model: sol } }] }));
  const sendPrompt = vi.fn(async () => undefined);
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [{ id: "limited", path: "/limited.jsonl", title: "Limited", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1, limit: { message: "You've hit your session limit", resetsAt: Date.now() + 60_000 } }] },
      detail: { sessionId: "limited", messages: [{ id: "user", role: "user", text: "hello", timestamp: 1 }], isStreaming: false, activeTools: [] },
      catalog,
      project: { cwd: "/project" },
    }),
    setModel, sendPrompt,
  });
  renderApp(client);
  fireEvent.click(await screen.findByRole("button", { name: "Switch model" }));
  const picker = await screen.findByRole("dialog", { name: "Select model" });
  fireEvent.click(await within(picker).findByRole("button", { name: "OpenAI" }));
  fireEvent.click(await within(picker).findByRole("option", { name: /^GPT-6.1 Sol, Pi/ }));
  await waitFor(() => expect(setModel).toHaveBeenCalledWith(sol.provider, sol.id, "limited"));
  expect(await screen.findByRole("button", { name: "Select model: GPT-6.1 Sol" })).toBeTruthy();
  const composer = screen.getByPlaceholderText(/Ask anything/);
  fireEvent.change(composer, { target: { value: "continue" } });
  fireEvent.keyDown(composer, { key: "Enter" });
  await waitFor(() => expect(sendPrompt).toHaveBeenCalledWith("continue", [], "limited", expect.anything(), undefined));
});

it("carries the selected Codex model and context into a new thread after a Pi limit", async () => {
  const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Opus 5.5" };
  const sol = { provider: "openai", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
  const backends = [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }];
  const catalogs = [{ kind: "codex", models: [sol], model: sol, thinkingLevels: {} }];
  const handoff = "<handoff_context>\nUser: Speed up the parser.\n</handoff_context>";
  const invokeHostExtension = vi.fn<HostClient["invokeHostExtension"]>(async (_extension, command) => {
    if (command === "create-transfer") return { transferId: "transfer", native: false, sourceTitle: "Limited" };
    if (command === "resolve-transfer") return { context: handoff };
    if (command === "state" || command === "bind-transfer") return { links: [] };
    if (command === "continue-targets") return [];
    return undefined;
  });
  const newSession = vi.fn<HostClient["newSession"]>(async () => ({ version: 1, updates: [], submission: { accepted: true } }));
  const preparePrompt = vi.fn<HostClient["preparePrompt"]>(async (text, _session, _skill, backend) => ({
    backendKind: backend ?? "pi", runtimeCapabilities: PI_AGENT_RUNTIME_ADAPTER.capabilities,
    visibleText: text, runtimeText: text, sourceFingerprint: "switch-model",
  }));
  const setModel = vi.fn(async () => ({ version: 1 as const, updates: [] }));
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions: [{ id: "limited", path: "/limited.jsonl", title: "Limited", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1, limit: { message: "You've hit your session limit", resetsAt: Date.now() + 60_000 } }] },
      detail: { sessionId: "limited", messages: [{ id: "user", role: "user", text: "Speed up the parser.", timestamp: 1 }], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "limited", backendKind: "pi", runtimeBackends: backends, models: [opus], model: opus, thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: "/project" },
    }),
    runtimeCatalogs: async () => catalogs,
    runtimeCatalog: async () => catalogs[0],
    invokeHostExtension, newSession, setModel, preparePrompt,
  });
  renderApp(client, { extensions: [createHandoffExtension(new HandoffStore())] });
  fireEvent.click(await screen.findByRole("button", { name: "Switch model" }));
  const picker = await screen.findByRole("dialog", { name: "Select model" });
  fireEvent.click(await within(picker).findByRole("button", { name: "OpenAI" }));
  fireEvent.click(await within(picker).findByRole("option", { name: /^GPT-6.1 Sol, Codex/ }));
  await waitFor(() => expect(invokeHostExtension).toHaveBeenCalledWith("tau.handoff", "create-transfer", { threadId: "limited", target: "codex" }));
  expect(await screen.findByRole("button", { name: "Select runtime and model: GPT-6.1 Sol" })).toBeTruthy();
  expect(setModel).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Resume now" })).toBeNull();
  const composer = screen.getByPlaceholderText(/Ask anything/);
  fireEvent.change(composer, { target: { value: "continue" } });
  fireEvent.keyDown(composer, { key: "Enter" });
  await waitFor(() => expect(newSession).toHaveBeenCalledWith(`${handoff}\n\ncontinue`, [], "/project", expect.anything(), expect.objectContaining({ backendKind: "codex" }),
    { model: { provider: sol.provider, id: sol.id } }));
});
