import { describe, expect, it, vi } from "vitest";
import type { ExtensionUiPrompt, GlobalHostEvent } from "../../shared/contracts.js";
import { HostExtensionRegistry, type HostExtensionServices, type HostThread, type HostUiPresenter, type RuntimeExtensionContribution } from "../host-extensions.js";
import { questionnaireOf } from "../../shared/questionnaire-protocol.js";
import { createComputerUseHostExtension } from "./computer-use-host-extension.js";
import { createKeybindingsHostExtension, readPiUserKeybindings } from "./keybindings-host-extension.js";
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
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: () => thread as HostThread | undefined,
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    refreshExtensionPackages: async () => undefined,
    sessions: {
      list: async () => [],
      open: () => { throw new Error("no sessions in this test"); },
      prepare: async () => { throw new Error("no sessions in this test"); },
      start: async () => { throw new Error("no threads in this test"); },
      exclusive: (work) => work(),
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: (decorator) => { decorators.push(decorator); return () => undefined; },
    registerRuntimeExtension: (name, factory, options) => { runtimeExtensions.push({ name, factory, ...options }); return () => undefined; },
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
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
    } as never, { sessionId: "s1", cwd: "/project" });
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
