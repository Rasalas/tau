import { describe, expect, it, vi } from "vitest";
import type { ExtensionUiPrompt, GlobalHostEvent } from "../../shared/contracts.js";
import { HostExtensionRegistry, type HostExtensionServices, type HostThread, type HostUiPresenter, type RuntimeExtensionContribution } from "../host-extensions.js";
import { createPiUiHostExtension } from "./pi-ui-host-extension.js";

function harness(thread?: Partial<HostThread>) {
  const events: GlobalHostEvent[] = [];
  const runtimeExtensions: RuntimeExtensionContribution[] = [];
  const decorators: Array<(prompt: ExtensionUiPrompt) => void> = [];
  const presenters: HostUiPresenter[] = [];
  const services: HostExtensionServices = {
    cwd: () => "/project",
    agentDir: "/agent",
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
    listPackages: async () => [],
    installPackage: async () => { throw new Error("no installer in this test"); },
    removePackage: async () => { throw new Error("no installer in this test"); },
    updatePackages: async () => [],
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
    loadRuntimeExtension: async () => { throw new Error("no runtime packages in this test"); },
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    presentUi: (presenter) => { presenters.push(presenter); return () => undefined; },
  };
  return { registry: new HostExtensionRegistry(services, (event) => events.push(event)), events, runtimeExtensions, decorators, presenters };
}

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
