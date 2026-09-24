import type { HostEvent } from "../../shared/contracts";
import type { HostClient } from "../../workbench/host-client";

/** One entry per call, in call order, across every method — default or overridden. */
export interface FakeHostClientCall {
  method: keyof HostClient;
  args: unknown[];
}

export type FakeHostClient = HostClient & {
  /** Feeds an event to every listener registered through `onHostEvent`. */
  emit(event: HostEvent): void;
  calls: FakeHostClientCall[];
};

function defaults(): HostClient {
  const listeners = new Set<(event: HostEvent) => void>();
  return {
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [], sessions: [] },
      detail: { sessionId: "", messages: [], isStreaming: false, activeTools: [] },
      catalog: { models: [], thinkingLevel: "", thinkingLevels: [], allTools: [], extensionCount: 0 },
      project: { cwd: "" },
    }),
    newSession: async () => ({ version: 1, updates: [], submission: { accepted: true } }),
    getPreparedThreadCapability: async (cwd) => ({ cwd: cwd ?? "", generation: 0 }),
    forkThread: async () => ({ version: 1, updates: [] }),
    threadTree: async (sessionId) => ({ sessionId: sessionId ?? "", nodes: [] }),
    navigateThreadTree: async () => ({ version: 1, updates: [], cancelled: true }),
    duplicateThread: async () => ({ version: 1, updates: [] }),
    switchSession: async () => ({ version: 1, updates: [] }),
    openProject: async () => ({ version: 1, updates: [] }),
    removeProject: async () => ({ version: 1, updates: [] }),
    renameThread: async () => ({ version: 1, updates: [] }),
    recoverThread: async () => ({ version: 1, updates: [] }),

    preparePrompt: async () => undefined,
    sendPrompt: async () => undefined,
    steer: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    queueMessage: async () => ({ id: "queued-1" }),
    takeQueued: async () => [],
    moveQueued: async () => undefined,
    resumeLimited: async () => undefined,
    runShellAction: async () => ({ output: "", cancelled: false, truncated: false }),

    loadTranscript: async (sessionId) => ({ sessionId, messages: [], hasMore: false }),
    readToolOutput: async () => undefined,
    toolOutput: async () => undefined,
    copyThreadMarkdown: async () => undefined,
    readImagePreview: async () => undefined,
    shareFile: async (path: string) => { throw new Error(`No file is shared in a test: ${path}`); },
    openExternalEditor: async (text: string) => ({ text, modified: false }),

    setModel: async () => ({ version: 1, updates: [] }),
    setThinkingLevel: async () => ({ version: 1, updates: [] }),
    setMode: async () => ({ version: 1, updates: [] }),
    compactContext: async () => ({ version: 1, updates: [] }),

    reloadRuntime: async () => undefined,
    reloadExtensions: async () => undefined,
    answerExtensionUi: async () => undefined,
    syncExtensionUi: async () => undefined,
    loadDesktopExtensions: async () => ({ bundles: [], errors: [], skipped: [] }),
    invokeHostExtension: async () => undefined,
    listHostExtensions: async () => [],
    inspectExtensions: async () => ({ versions: { tau: "", pi: "", api: "" }, directories: [], packages: [], errors: [], skipped: [] }),
    setHostExtensionActive: async () => [],
    grantExtension: async () => undefined,

    prepareWorkbenchReload: async () => ({ ready: true, runningThreads: 0 }),
    releaseWorkbenchReload: async () => undefined,
    rebuildWorkbench: async () => ({ ok: true, durationMs: 0, mainChanged: false, runtimeChanged: false, output: "" }),
    workbenchSource: async () => ({}),
    relaunchWorkbench: async () => undefined,
    installUpdate: async () => ({ installing: false }),

    getConfig: async () => ({}),
    updateConfig: async () => ({}),
    getConfigLayers: async () => ({ host: {} }),
    clearConfig: async () => ({ host: {} }),
    getModelsConfig: async () => [],
    runtimeCatalog: async () => undefined,
    runtimeCatalogs: async () => [],
    addModelProvider: async () => [],
    inspectSystemPrompt: async () => ({ effectivePrompt: "", appends: [], contextFiles: [] }),
    listUserThemes: async () => [],

    platform: "test",
    copyText: async () => undefined,
    copyImage: async () => undefined,
    showNotification: async () => "dismissed",
    setBadge: async () => undefined,
    // Refused like a client without native menus, so right-clicks fall back to the page's own menu.
    showContextMenu: async () => { throw Object.assign(new Error("No native menus in tests."), { code: "unsupported" }); },
    windowAction: async () => { throw Object.assign(new Error("No window process in tests."), { code: "unsupported" }); },
    onHostEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hasCapability: () => true,
    isReadOnly: () => false,
    getConnectionState: () => "connected",
    getConnectionRefusal: () => undefined,
    onConnectionState: () => () => undefined,
    getConnectionLink: () => undefined,
    onConnectionLink: () => () => undefined,
    reconnectNow: () => undefined,
    watchThread: () => () => undefined,
    watchNewThread: () => () => undefined,
    watchHostTopic: () => () => undefined,
    limitPushesToWatched: () => undefined,
    getVersions: () => ({}),
    onVersions: () => () => undefined,
    listConnections: async () => ({ scheme: "ws", endpoints: [], webClient: false, tokenPath: "", links: [], requests: [], clients: [], owners: [] }),
    createPairingLink: async () => { throw Object.assign(new Error("No pairing in tests."), { code: "unsupported" }); },
    revokePairingLink: async () => ({ revoked: false }),
    revokeClient: async () => ({ revoked: false }),
    revokeOtherClients: async () => ({ revoked: 0 }),
    updateClient: async () => ({ updated: false }),
    approvePairing: async () => ({ approved: false }),
    denyPairing: async () => ({ denied: false }),
    rotateHostToken: async () => undefined,
    setNetworkAccess: async () => { throw Object.assign(new Error("No network access in tests."), { code: "unsupported" }); },
    reloadCertificate: async () => ({ changed: false }),
    discoverHosts: async () => ({ hosts: [], serviceType: "_tau-test._tcp" }),
    // No service unless a test gives one: the section says the host cannot run as one.
    serviceStatus: async () => { throw Object.assign(new Error("No service in tests."), { code: "unknown-method" }); },
    installService: async () => { throw Object.assign(new Error("No service in tests."), { code: "unknown-method" }); },
    uninstallService: async () => { throw Object.assign(new Error("No service in tests."), { code: "unknown-method" }); },
    // No window process in tests unless one is given: the page shows no other machines.
    listEnvironments: async () => { throw Object.assign(new Error("No machines in tests."), { code: "unsupported" }); },
    pairEnvironment: async () => ({ state: "failed", message: "No machines in tests." }),
    cancelEnvironmentPairing: async () => undefined,
    renameEnvironment: async () => ({ renamed: false }),
    removeEnvironment: async () => ({ removed: false }),
    retryEnvironment: async () => undefined,
    openEnvironment: async () => undefined,
    takeEnvironmentArrival: async () => undefined,
    // Exposed only through the FakeHostClient wrapper below; kept here so
    // `emit` shares the same listener set as the default `onHostEvent`.
    __emit: (event: HostEvent) => listeners.forEach((listener) => listener(event)),
  } as HostClient & { __emit(event: HostEvent): void };
}

/**
 * A complete, typed double for `HostClient`. Every method resolves to a
 * sensible empty value unless `overrides` replaces it; `emit` drives whatever
 * `onHostEvent` listeners are registered, including the default one.
 */
export function createFakeHostClient(overrides: Partial<HostClient> = {}): FakeHostClient {
  const base = defaults();
  const { __emit, ...defaultMethods } = base as HostClient & { __emit(event: HostEvent): void };
  const calls: FakeHostClientCall[] = [];
  const merged = { ...defaultMethods, ...overrides };

  const client: Record<string, unknown> = {};
  for (const key of Object.keys(merged) as (keyof HostClient)[]) {
    const value = merged[key];
    if (typeof value !== "function") {
      client[key] = value;
      continue;
    }
    client[key] = (...args: unknown[]) => {
      calls.push({ method: key, args });
      return (value as (...fnArgs: unknown[]) => unknown)(...args);
    };
  }
  client.emit = (event: HostEvent) => __emit(event);
  client.calls = calls;
  // Built generically from every HostClient key; the shape is right by
  // construction, but the loop above is opaque to the type checker.
  return client as unknown as FakeHostClient;
}
