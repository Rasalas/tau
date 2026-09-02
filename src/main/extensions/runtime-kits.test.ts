import { describe, expect, it, vi } from "vitest";
import type { ExtensionUiPrompt, GlobalHostEvent } from "../../shared/contracts.js";
import { HostExtensionRegistry, type HostExtensionServices, type HostThread, type HostUiPresenter, type RuntimeExtensionContribution } from "../host-extensions.js";
import { questionnaireOf } from "../../shared/questionnaire-protocol.js";
import { createComputerUseHostExtension } from "./computer-use-host-extension.js";
import { createKeybindingsHostExtension, readPiUserKeybindings } from "./keybindings-host-extension.js";
import { createPiUiHostExtension } from "./pi-ui-host-extension.js";
import { createQuestionnaireHostExtension } from "./questionnaire-host-extension.js";
import { createServiceTierHostExtension } from "./service-tier-host-extension.js";

function harness(thread?: Partial<HostThread>) {
  const events: GlobalHostEvent[] = [];
  const runtimeExtensions: RuntimeExtensionContribution[] = [];
  const decorators: Array<(prompt: ExtensionUiPrompt) => void> = [];
  const presenters: HostUiPresenter[] = [];
  const services: HostExtensionServices = {
    cwd: () => "/project",
    safeMode: false,
    log: vi.fn(),
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    git: {} as never,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: () => thread as HostThread | undefined,
    setThreadTitle: async () => undefined,
    checkpoints: { canRestore: async () => false, restorePreview: async () => ({ files: [], added: 0, removed: 0 }), restore: async () => ({ version: 1 as const, updates: [] }), turnFileDiff: async () => ({ path: "", added: 0, removed: 0, hunks: [] }), turnFiles: async () => ({ sessionId: "", checkpointId: "", files: [], added: 0, removed: 0, fileCount: 0, hasMore: false }), subscribe: () => () => undefined },
    decorateUiPrompt: (decorator) => { decorators.push(decorator); return () => undefined; },
    registerRuntimeExtension: (name, factory, options) => { runtimeExtensions.push({ name, factory, ...options }); return () => undefined; },
    setPermissionPolicy: () => undefined,
    presentUi: (presenter) => { presenters.push(presenter); return () => undefined; },
  };
  return { registry: new HostExtensionRegistry(services, (event) => events.push(event)), events, runtimeExtensions, decorators, presenters };
}

describe("Service Tier host extension", () => {
  it("reports availability from the active model's API and publishes tier changes", async () => {
    const { registry, events, runtimeExtensions } = harness({ modelApi: () => "openai-responses" });
    await registry.activate(createServiceTierHostExtension());
    expect(runtimeExtensions.map((entry) => entry.name)).toEqual(["tau-service-tier"]);
    await expect(registry.invoke("tau.service-tier", "state")).resolves.toEqual({ tier: "standard", available: true });
    await expect(registry.invoke("tau.service-tier", "set-tier", { tier: "fast" })).resolves.toEqual({ tier: "fast", available: true });
    expect(events).toEqual([{ type: "extension-event", extensionId: "tau.service-tier", name: "state", payload: { tier: "fast", available: true } }]);
    await expect(registry.invoke("tau.service-tier", "set-tier", { tier: "turbo" })).rejects.toThrow("Service tier must be standard or fast.");
  });

  it("is unavailable for APIs without a priority tier", async () => {
    const { registry } = harness({ modelApi: () => "anthropic-messages" });
    await registry.activate(createServiceTierHostExtension());
    await expect(registry.invoke("tau.service-tier", "state")).resolves.toEqual({ tier: "standard", available: false });
  });
});

describe("Questionnaire host extension", () => {
  it("tags select and input dialogs with their place in the announced questionnaire", async () => {
    const { registry, runtimeExtensions, decorators } = harness();
    await registry.activate(createQuestionnaireHostExtension());
    // Drive the Pi extension the kit contributed with a fake ExtensionAPI.
    const busHandlers = new Map<string, (payload: unknown) => void>();
    const piHandlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    runtimeExtensions[0]!.factory({
      on: (event: string, handler: (event: unknown, ctx: unknown) => void) => { piHandlers.set(event, handler); },
      events: { on: (name: string, handler: (payload: unknown) => void) => { busHandlers.set(name, handler); } },
    } as never);
    piHandlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "s1" } });
    busHandlers.get("rpiv:ask-user:prompt")?.({ questions: [
      { question: "Which colour?", header: "Theme", options: [{ label: "red" }, { label: "blue" }] },
      { question: "Which size?", options: [{ label: "s" }] },
    ] });
    const prompt = { id: "p1", sessionId: "s1", kind: "select", title: "[Theme] Which colour?", options: ["red", "blue"] } as ExtensionUiPrompt;
    decorators.forEach((decorate) => decorate(prompt));
    expect(questionnaireOf(prompt)?.index).toBe(0);
    expect(questionnaireOf(prompt)?.questions).toHaveLength(2);
    const confirm = { id: "p2", sessionId: "s1", kind: "confirm", title: "Sure?", message: "" } as ExtensionUiPrompt;
    decorators.forEach((decorate) => decorate(confirm));
    expect(questionnaireOf(confirm)).toBeUndefined();
  });
});

describe("Computer Use host extension", () => {
  it("stands down when the user already configured the Pi package", async () => {
    const { registry, runtimeExtensions } = harness();
    await registry.activate(createComputerUseHostExtension());
    const [contribution] = runtimeExtensions;
    expect(contribution?.name).toBe("tau-computer-use");
    expect(contribution?.enabledFor?.({ global: {}, project: {} })).toBe(true);
    expect(contribution?.enabledFor?.({ global: { packages: ["npm:@amaster.ai/pi-computer-use"] }, project: {} })).toBe(false);
    expect(contribution?.enabledFor?.({ global: {}, project: { packages: [{ source: "npm:@amaster.ai/pi-computer-use@1.0.0" }] } })).toBe(false);
  });
});

describe("Keybindings host extension", () => {
  it("reads the user's keybindings.json and routes Pi shortcuts to the thread", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const agentDir = await mkdtemp(join(tmpdir(), "tau-keys-"));
    await writeFile(join(agentDir, "keybindings.json"), JSON.stringify({ "app.session.new": "ctrl+n", "app.interrupt": ["escape", "ctrl+c"], "app.exit": 7 }));
    const ran: string[] = [];
    const { registry } = harness({
      sessionId: "s1",
      shortcuts: (bindings) => [{ keys: "ctrl+shift+p", description: `pick (${Object.keys(bindings).length} user bindings)`, source: "persona.ts" }],
      runShortcut: async (keys) => { ran.push(keys); return keys === "ctrl+shift+p"; },
    });
    await registry.activate(createKeybindingsHostExtension({ agentDir }));
    await expect(registry.invoke("tau.runtime-settings", "pi-keybindings")).resolves.toEqual({ bindings: { "app.session.new": ["ctrl+n"], "app.interrupt": ["escape", "ctrl+c"] } });
    await expect(registry.invoke("tau.runtime-settings", "shortcuts")).resolves.toEqual({ sessionId: "s1", shortcuts: [{ keys: "ctrl+shift+p", description: "pick (2 user bindings)", source: "persona.ts" }] });
    await registry.invoke("tau.runtime-settings", "run-shortcut", { keys: "ctrl+shift+p" });
    await expect(registry.invoke("tau.runtime-settings", "run-shortcut", { keys: "ctrl+x" })).rejects.toThrow("Pi has no shortcut for ctrl+x.");
    expect(ran).toEqual(["ctrl+shift+p", "ctrl+x"]);
    await expect(readPiUserKeybindings(join(agentDir, "missing"))).resolves.toEqual({});
  });
});

describe("Pi UI host extension", () => {
  it("keeps statuses, widgets and the working message per thread and publishes changes", async () => {
    const { registry, events, presenters } = harness({ sessionId: "s1" });
    await registry.activate(createPiUiHostExtension());
    const [presenter] = presenters;
    presenter!.setStatus!("s1", "git", "main*");
    presenter!.setStatus!("s1", "vim", "NORMAL");
    presenter!.setWidget!("s1", "todo", ["[ ] tests", "[x] code"], "belowEditor");
    presenter!.setWorkingMessage!("s1", "Thinking hard");
    presenter!.setStatus!("s1", "git", undefined);
    await expect(registry.invoke("tau.pi-ui", "state")).resolves.toEqual({
      sessionId: "s1",
      statuses: [{ key: "vim", text: "NORMAL" }],
      widgets: [{ key: "todo", lines: ["[ ] tests", "[x] code"], placement: "belowEditor" }],
      working: "Thinking hard",
    });
    await expect(registry.invoke("tau.pi-ui", "state", { sessionId: "other" })).resolves.toEqual({ sessionId: "other", statuses: [], widgets: [] });
    expect(events.filter((event) => event.type === "extension-event" && event.extensionId === "tau.pi-ui")).toHaveLength(5);
    presenter!.clear!("s1");
    await expect(registry.invoke("tau.pi-ui", "state")).resolves.toEqual({ sessionId: "s1", statuses: [], widgets: [] });
    presenter!.clear!("s1");
    expect(events).toHaveLength(6);
  });
});
