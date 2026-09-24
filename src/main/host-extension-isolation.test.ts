import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GlobalHostEvent } from "../shared/contracts.js";
import { bundleHostExtension, writeHostExtensionBundle } from "./extension-packages.js";
import { createWorkerHostExtension, type WorkerHostExtensionOptions } from "./host-extension-isolation.js";
import { HostExtensionRegistry, type HostExtension, type HostExtensionServices, type HostThreadLifecycle, type HostThread, type HostThreadStartOptions } from "./host-extensions.js";

/**
 * The isolated half of ADR 0009: a package's host entry, bundled by the real
 * pipeline, running in a worker that cannot reach Electron, cannot outlive its
 * heap cap and cannot take the host down.
 */

const FIXTURE = `
export default {
  id: "acme.worker",
  name: "Worker Package",
  activate(context) {
    const { services } = context;
    context.registerCommand("hello", async (input) => {
      const cwd = await services.cwd();
      context.emit("greeted", { input });
      context.emit("streamed", 1, { topic: "feed" });
      return { cwd, input, safeMode: services.safeMode };
    });
    context.registerCommand("sessions", async () => (await services.sessions.list()).length);
    context.registerCommand("tidy", () => "tidied", { audit: { label: "tidied up", automatic: true } });
    context.registerCommand("caller", async (_input, call) => ({ call, devices: await services.clients.devices() }));
    context.registerCommand("proxy-read", (input) => context.invokeHostExtension("acme.target", "read", input));
    context.registerCommand("proxy-restricted", (input) => context.invokeHostExtension("acme.target", "restricted", input));
    context.registerCommand("electron", () => require("electron").app.getName());
    context.registerCommand("spin", () => { while (true) { /* a synchronous loop the host must survive */ } });
    context.registerCommand("die", () => { process.exit(3); });
    context.registerCommand("eat", () => {
      const held = [];
      for (;;) held.push(new Uint8Array(4 * 1024 * 1024).fill(held.length % 255));
    });
    context.registerCommand("facade", async () => {
      const inside = await services.sessions.exclusive(async () => (await services.thread())?.sessionId ?? "none");
      await services.pinTranscriptEntries({ "session-1": ["entry-1"] });
      await services.registerThreadLifecycle({
        beforeWorkspace: async (cwd) => { services.log("fixture.beforeWorkspace", cwd); },
      });
      await services.describeProjects({ name: async (cwd) => "named " + cwd });
      await services.setPendingWork("session-1", 2);
      const started = await services.sessions.start({ cwd: "/project", prompt: "go", title: "Child" });
      return { inside, started, unavailable: describeUnavailable(services) };
    });
    let releases = [];
    context.registerCommand("network", async () => {
      releases.push(await services.network.holdProxy());
      releases.push(await services.network.publishEndpoints([{ url: "https://box.tail0000.ts.net/", label: "Served", reachability: "network" }]));
      return services.network.state();
    });
    context.registerCommand("network-release", () => { for (const release of releases.splice(0)) release(); });
  },
};

function describeUnavailable(services) {
  try {
    services.registerRuntimeBackend({ kind: "acme" });
    return "reached";
  } catch (error) {
    return error.message;
  }
}
`;

const ELECTRON_FIXTURE = `
import { app } from "electron";
export default { activate() { app.getName(); } };
`;

/** Both ways out to the network: the global and the socket builtin. */
const NETWORK_FIXTURE = `
export default {
  id: "acme.network",
  name: "Network Package",
  activate(context) {
    context.registerCommand("fetch", async (input) => {
      const response = await fetch("http://127.0.0.1:" + input.port + "/ping");
      return await response.text();
    });
    context.registerCommand("require-http", () => typeof require("http").request);
    context.registerCommand("require-node-dns", () => typeof require("node:dns/promises").lookup);
  },
};
`;

/** Every way out of the worker the two enforced grants cover. */
const PROCESS_FIXTURE = `
export default {
  id: "acme.process",
  name: "Process Package",
  activate(context) {
    context.registerCommand("require-spawn", () => typeof require("child_process").spawnSync);
    context.registerCommand("require-node-spawn", () => typeof require("node:child_process").execFileSync);
    context.registerCommand("import-spawn", async () => typeof (await import("node:child_process")).spawnSync);
    context.registerCommand("import-https", async () => typeof (await import("node:https")).request);
    context.registerCommand("nested-worker", () => typeof require("node:worker_threads").Worker);
    context.registerCommand("run", () => require("child_process").execFileSync("echo", ["ran"]).toString().trim());
  },
};
`;

interface Recorder {
  logs: string[];
  lifecycles: HostThreadLifecycle[];
  pins: Array<(thread: HostThread) => Iterable<string>>;
  pending: Array<(sessionId: string) => number>;
  names: Array<(cwd: string) => Promise<string | undefined>>;
  started: HostThreadStartOptions[];
  removed: string[];
  exclusiveDepth: number;
  clientCount: number;
  proxyHolds: number;
  published: unknown[][];
}

function services(): { services: HostExtensionServices; recorder: Recorder } {
  const recorder: Recorder = { logs: [], lifecycles: [], pins: [], pending: [], names: [], started: [], removed: [], exclusiveDepth: 0, clientCount: 1, proxyHolds: 0, published: [] };
  const facade: HostExtensionServices = {
    cwd: () => "/project",
    complete: async () => "",
    agentDir: "/agent",
    sessionsDir: "/agent/sessions",
    stateDir: "/state",
    themesDir: "/themes",
    safeMode: false,
    log: (label, detail) => { recorder.logs.push(detail ? `${label} ${detail}` : label); },
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    workspaceRef: (path) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    admitWorkspace: (path) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: () => ({
      sessionId: "session-1",
      cwd: "/project",
      backendKind: "pi" as const,
      sessionFile: "/sessions/one.jsonl",
      sessionName: () => "One",
      isStreaming: () => false,
      isIdle: () => true,
      isCurrent: () => true,
    } as unknown as HostThread),
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: (facts) => {
      if (facts.name) recorder.names.push(facts.name);
      return () => undefined;
    },
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    skills: () => [],
    refreshExtensionPackages: async () => undefined,
    listPackages: async () => [],
    installPackage: async () => { throw new Error("no installer in this test"); },
    removePackage: async () => { throw new Error("no installer in this test"); },
    updatePackages: async () => [],
    sessions: {
      list: async () => [{ sessionId: "session-1", path: "/sessions/one.jsonl", cwd: "/project" }],
      open: () => { throw new Error("no session files in this test"); },
      prepare: async () => { throw new Error("no runtimes in this test"); },
      start: async (options) => {
        recorder.started.push(options);
        return { sessionId: "session-2", cwd: options.cwd, ...(options.title ? { title: options.title } : {}) };
      },
      remove: async (sessionId) => { recorder.removed.push(sessionId); },
      restore: async () => undefined,
      trash: async () => [],
      purge: async () => undefined,
      exclusive: async (work) => {
        recorder.exclusiveDepth += 1;
        try { return await work(); } finally { recorder.exclusiveDepth -= 1; }
      },
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    clients: { observe: () => () => undefined, count: () => recorder.clientCount, devices: () => [{ id: "p1", name: "iPhone", access: "full" }] },
    network: {
      state: () => ({ settings: { lan: false, tailscale: false, announce: false, port: 7788, proxyPort: 7789 }, listeners: [], problems: [], tailscaleUp: false, proxyHeld: recorder.proxyHolds > 0 }),
      holdProxy: async () => { recorder.proxyHolds += 1; return () => { recorder.proxyHolds -= 1; }; },
      keepProxy: async () => undefined,
      publishEndpoints: (endpoints) => {
        const entry = [...endpoints];
        recorder.published.push(entry);
        return () => { recorder.published.splice(recorder.published.indexOf(entry), 1); };
      },
    },
    registerThreadLifecycle: (lifecycle) => { recorder.lifecycles.push(lifecycle); return () => undefined; },
    registerTurnObserver: (observer) => { if (observer.pending) recorder.pending.push(observer.pending); return () => undefined; },
    pinTranscriptEntries: (provider) => { recorder.pins.push(provider); return () => undefined; },
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    loadRuntimeExtension: async () => { throw new Error("no runtime packages in this test"); },
    loadDependency: async () => { throw new Error("no dependencies in this test"); },
    mcp: { registerTools: () => () => undefined, gate: () => () => undefined, connect: async () => undefined },
    callClient: async () => { throw new Error("no client in this test"); },
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    observeConfigChanges: () => () => undefined,
    presentUi: () => () => undefined,
  };
  return { services: facade, recorder };
}

let scratch: string;
let bundle: string;
let electronBundle: string;
let networkBundle: string;
let processBundle: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "tau-worker-package-"));
  await writeFile(join(scratch, "host.ts"), FIXTURE);
  await writeFile(join(scratch, "electron-host.ts"), ELECTRON_FIXTURE);
  const manifest = { id: "acme.worker", name: "Worker Package" };
  bundle = await writeHostExtensionBundle(await bundleHostExtension(join(scratch, "host.ts")), manifest, scratch);
  electronBundle = await writeHostExtensionBundle(
    await bundleHostExtension(join(scratch, "electron-host.ts")),
    { id: "acme.electron", name: "Electron Package" },
    scratch,
  );
  await writeFile(join(scratch, "network-host.ts"), NETWORK_FIXTURE);
  networkBundle = await writeHostExtensionBundle(
    await bundleHostExtension(join(scratch, "network-host.ts")),
    { id: "acme.network", name: "Network Package" },
    scratch,
  );
  await writeFile(join(scratch, "process-host.ts"), PROCESS_FIXTURE);
  processBundle = await writeHostExtensionBundle(
    await bundleHostExtension(join(scratch, "process-host.ts")),
    { id: "acme.process", name: "Process Package" },
    scratch,
  );
}, 60_000);

afterAll(async () => { await rm(scratch, { recursive: true, force: true }); });

function harness(options: { permissions?: string[]; commandTimeoutMs?: number } & Partial<WorkerHostExtensionOptions> = {}) {
  const { permissions = ["workspace:read", "sessions"], commandTimeoutMs = 5_000, ...worker } = options;
  const events: GlobalHostEvent[] = [];
  const { services: facade, recorder } = services();
  const registry = new HostExtensionRegistry(facade, (event) => events.push(event), { commandTimeoutMs });
  const extension = createWorkerHostExtension({
    id: "acme.worker",
    name: "Worker Package",
    permissions,
    file: bundle,
    hookTimeoutMs: 5_000,
    ...worker,
  });
  return { registry, extension, events, recorder };
}

async function until(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("isolated host extensions", () => {
  it("runs commands, emits events and reaches the services it was granted", async () => {
    const { registry, extension, events } = harness();
    await expect(registry.activate(extension)).resolves.toBe(true);
    try {
      await expect(registry.invoke("acme.worker", "hello", { a: 1 })).resolves.toEqual({ cwd: "/project", input: { a: 1 }, safeMode: false });
      expect(events).toEqual([
        { type: "extension-event", extensionId: "acme.worker", name: "greeted", payload: { input: { a: 1 } } },
        { type: "extension-event", extensionId: "acme.worker", name: "streamed", payload: 1, topic: "feed" },
      ]);
      await expect(registry.invoke("acme.worker", "sessions")).resolves.toBe(1);
      expect(registry.summaries()[0]).toMatchObject({ id: "acme.worker", active: true, isolation: "worker" });
      expect(registry.summaries()[0]?.commands).toContain("hello");
    } finally {
      await registry.dispose();
    }
  });

  it("tells a worker's command who called it, and lists the paired devices", async () => {
    const { registry, extension } = harness();
    await registry.activate(extension);
    try {
      await expect(registry.invoke("acme.worker", "caller", undefined, { kind: "workbench-client", connection: "c1", pairedClient: "p1" })).resolves.toEqual({
        call: { device: "p1", owner: false },
        devices: [{ id: "p1", name: "iPhone", access: "full" }],
      });
    } finally {
      await registry.dispose();
    }
  });

  it("records a worker's command the way it declared", async () => {
    const { registry, extension } = harness();
    await registry.activate(extension);
    try {
      const calls: unknown[] = [];
      const phone = { kind: "workbench-client", connection: "c1", pairedClient: "p1", audit: (call: unknown) => calls.push(call) } as const;
      await expect(registry.invoke("acme.worker", "tidy", { threadId: "t-1" }, phone)).resolves.toBe("tidied");
      expect(calls).toEqual([{ action: "acme.worker/tidy", label: "tidied up", threadId: "t-1", automatic: true }]);
    } finally {
      await registry.dispose();
    }
  });

  it("enforces permissions on the main side, so a worker cannot reach past its grant", async () => {
    const { registry, extension, recorder } = harness({ permissions: ["workspace:read"] });
    await registry.activate(extension);
    try {
      await expect(registry.invoke("acme.worker", "sessions")).rejects.toThrow("Extension acme.worker lacks permission sessions");
      expect(recorder.logs.some((line) => line.startsWith("host-extension.denied"))).toBe(true);
    } finally {
      await registry.dispose();
    }
  });

  it("keeps repeated worker-side permission denials out of the crash counter", async () => {
    const { registry, extension, recorder } = harness({ permissions: ["workspace:read"] });
    await registry.activate(extension);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // Sequential calls are required to exercise the consecutive-failure counter.
        // oxlint-disable-next-line eslint/no-await-in-loop
        await expect(registry.invoke("acme.worker", "sessions")).rejects.toThrow("Extension acme.worker lacks permission sessions");
      }
      expect(registry.isActive("acme.worker")).toBe(true);
      expect(recorder.logs.filter((line) => line.startsWith("host-extension.denied"))).toHaveLength(3);
      expect(recorder.logs.some((line) => line.startsWith("host-extension.failed"))).toBe(false);
    } finally {
      await registry.dispose();
    }
  });

  it("forwards a worker's host-issued caller context to the target registry", async () => {
    const { registry, extension } = harness();
    const target: HostExtension = {
      id: "acme.target",
      name: "Target Extension",
      activate: (context) => {
        context.registerCommand("read", (input) => ({ input }), { callers: ["acme.worker"] });
        context.registerCommand("restricted", () => "secret");
      },
    };
    await registry.activate(target);
    await registry.activate(extension);
    try {
      await expect(registry.invoke("acme.worker", "proxy-read", { callerId: "forged" })).resolves.toEqual({ input: { callerId: "forged" } });
      await expect(registry.invoke("acme.worker", "proxy-restricted")).rejects.toMatchObject({
        name: "HostAuthorizationError",
        code: "unauthorized",
        expected: true,
        details: { caller: "acme.worker", target: "acme.target", command: "restricted", capability: "acme.target/restricted" },
      });
      expect(registry.isActive("acme.target")).toBe(true);
      expect(registry.isActive("acme.worker")).toBe(true);
    } finally {
      await registry.dispose();
    }
  });

  it("offers the plain-data facade and refuses what would hand out a live object", async () => {
    const { registry, extension, recorder } = harness();
    await registry.activate(extension);
    try {
      const result = await registry.invoke("acme.worker", "facade") as { inside: string; started: unknown; unavailable: string };
      expect(result.inside).toBe("session-1");
      expect(result.started).toEqual({ sessionId: "session-2", cwd: "/project", title: "Child" });
      expect(recorder.started).toEqual([{ cwd: "/project", prompt: "go", title: "Child" }]);
      expect(result.unavailable).toContain("not available to an isolated host extension");
      expect(recorder.exclusiveDepth).toBe(0);
      expect([...recorder.pins[0]!({ sessionId: "session-1" } as HostThread)]).toEqual(["entry-1"]);
      expect(recorder.pending[0]!("session-1")).toBe(2);
      await expect(recorder.names[0]!("/repo")).resolves.toBe("named /repo");
      await recorder.lifecycles[0]!.beforeWorkspace?.("/repo");
      expect(recorder.logs).toContain("fixture.beforeWorkspace /repo");
    } finally {
      await registry.dispose();
    }
  });

  it("holds the proxy listener and publishes endpoints until the worker releases them or stops", async () => {
    const { registry, extension, recorder } = harness({ permissions: ["network"] });
    await registry.activate(extension);
    try {
      await expect(registry.invoke("acme.worker", "network")).resolves.toMatchObject({ proxyHeld: true });
      expect(recorder.published).toEqual([[{ url: "https://box.tail0000.ts.net/", label: "Served", reachability: "network" }]]);
      await registry.invoke("acme.worker", "network-release");
      await until(() => recorder.proxyHolds === 0 && recorder.published.length === 0);
      await registry.invoke("acme.worker", "network");
      expect(recorder.proxyHolds).toBe(1);
    } finally {
      await registry.dispose();
    }
    expect(recorder.proxyHolds).toBe(0);
    expect(recorder.published).toEqual([]);
  });

  it("refuses network access to a worker without the grant", async () => {
    const { registry, extension } = harness({ permissions: ["sessions"] });
    await registry.activate(extension);
    try {
      await expect(registry.invoke("acme.worker", "network")).rejects.toThrow("lacks permission network");
    } finally {
      await registry.dispose();
    }
  });

  it("refuses Electron inside a worker, with a reason the settings page can show", async () => {
    const { registry } = harness();
    const electron = createWorkerHostExtension({ id: "acme.electron", name: "Electron Package", permissions: [], file: electronBundle });
    await expect(registry.activate(electron)).resolves.toBe(false);
    expect(registry.summaries()[0]?.error).toContain("Electron is not available");
    expect(registry.isActive("acme.electron")).toBe(false);
  });

  it("terminates a synchronous infinite loop when the command times out", async () => {
    const { registry, extension } = harness({ commandTimeoutMs: 1_000 });
    await registry.activate(extension);
    await expect(registry.invoke("acme.worker", "spin")).rejects.toThrow(/timed out after 1000ms/u);
    await until(() => !registry.isActive("acme.worker"));
    expect(registry.summaries()[0]?.error).toContain("timed out");
    // The host is still there and still answers for the package.
    await expect(registry.invoke("acme.worker", "hello")).rejects.toThrow("is not active");
  }, 30_000);

  it("survives a worker that leaves the process", async () => {
    const { registry, extension } = harness();
    await registry.activate(extension);
    await expect(registry.invoke("acme.worker", "die")).rejects.toThrow(/left the host process/u);
    await until(() => !registry.isActive("acme.worker"));
    expect(registry.summaries()[0]?.error).toContain("worker exit code 3");
  }, 30_000);

  it("holds a package to its heap cap", async () => {
    const { registry, extension } = harness({ resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 }, commandTimeoutMs: 20_000 });
    await registry.activate(extension);
    await expect(registry.invoke("acme.worker", "eat")).rejects.toThrow();
    await until(() => !registry.isActive("acme.worker"));
    expect(registry.summaries()[0]?.error).toBeTruthy();
  }, 40_000);

  const spawner = (permissions: string[]) => harness({ permissions, id: "acme.process", name: "Process Package", file: processBundle });

  describe("the network permission", () => {
    const network = (permissions: string[]) => harness({ permissions, id: "acme.network", name: "Network Package", file: networkBundle });

    let server: Server;
    let port: number;

    beforeAll(async () => {
      server = createServer((_request, response) => { response.end("pong"); });
      await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
      port = (server.address() as { port: number }).port;
    });

    afterAll(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); }); });

    it("refuses fetch and the socket builtins without it, and logs the denial", async () => {
      const { registry, extension, recorder } = network(["workspace:read"]);
      await expect(registry.activate(extension)).resolves.toBe(true);
      try {
        await expect(registry.invoke("acme.network", "fetch", { port })).rejects.toThrow("Extension acme.network lacks permission network");
        await expect(registry.invoke("acme.network", "require-http")).rejects.toThrow("Extension acme.network lacks permission network");
        expect(registry.isActive("acme.network")).toBe(true);
        const denials = recorder.logs.filter((line) => line.startsWith("host-extension.denied"));
        expect(denials).toEqual([
          "host-extension.denied Extension acme.network lacks permission network (fetch)",
          'host-extension.denied Extension acme.network lacks permission network (require("http"))',
        ]);
      } finally {
        await registry.dispose();
      }
    }, 30_000);

    it("refuses a node: prefixed builtin and its submodule too", async () => {
      const { registry, extension } = network([]);
      await registry.activate(extension);
      try {
        await expect(registry.invoke("acme.network", "require-node-dns")).rejects.toThrow("Extension acme.network lacks permission network");
      } finally {
        await registry.dispose();
      }
    }, 30_000);

    it("refuses a dynamic import of a socket builtin too", async () => {
      const { registry, extension } = spawner([]);
      await registry.activate(extension);
      try {
        await expect(registry.invoke("acme.process", "import-https")).rejects.toThrow("Extension acme.process lacks permission network");
      } finally {
        await registry.dispose();
      }
    }, 30_000);

    it("lets a granted package reach the network", async () => {
      const { registry, extension, recorder } = network(["network"]);
      await registry.activate(extension);
      try {
        await expect(registry.invoke("acme.network", "fetch", { port })).resolves.toBe("pong");
        await expect(registry.invoke("acme.network", "require-http")).resolves.toBe("function");
        expect(recorder.logs.filter((line) => line.startsWith("host-extension.denied"))).toEqual([]);
      } finally {
        await registry.dispose();
      }
    }, 30_000);
  });

  describe("the process permission", () => {
    it("refuses child_process without the grant, however it is asked for", async () => {
      const { registry, extension, recorder } = spawner(["workspace:read"]);
      await expect(registry.activate(extension)).resolves.toBe(true);
      try {
        for (const command of ["require-spawn", "require-node-spawn", "import-spawn"]) {
          await expect(registry.invoke("acme.process", command)).rejects.toThrow("Extension acme.process lacks permission process");
        }
        // A denial is an authorization answer, not a crash: the package lives on.
        expect(registry.isActive("acme.process")).toBe(true);
        expect(recorder.logs.filter((line) => line.startsWith("host-extension.denied"))).toEqual([
          'host-extension.denied Extension acme.process lacks permission process (require("child_process"))',
          'host-extension.denied Extension acme.process lacks permission process (require("node:child_process"))',
          "host-extension.denied Extension acme.process lacks permission process (import node:child_process)",
        ]);
      } finally {
        await registry.dispose();
      }
    }, 30_000);

    it("refuses a nested worker, which would run outside both guards", async () => {
      const { registry, extension } = spawner(["process"]);
      await registry.activate(extension);
      try {
        await expect(registry.invoke("acme.process", "nested-worker")).rejects.toThrow(/may not start a worker thread/u);
      } finally {
        await registry.dispose();
      }
    }, 30_000);

    it("lets a granted package spawn, and start a worker once nothing is left to escape", async () => {
      const { registry, extension, recorder } = spawner(["process", "network"]);
      await registry.activate(extension);
      try {
        await expect(registry.invoke("acme.process", "run")).resolves.toBe("ran");
        await expect(registry.invoke("acme.process", "nested-worker")).resolves.toBe("function");
        expect(recorder.logs.filter((line) => line.startsWith("host-extension.denied"))).toEqual([]);
      } finally {
        await registry.dispose();
      }
    }, 30_000);
  });
});
