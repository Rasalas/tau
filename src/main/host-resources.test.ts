import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiRuntimeBackend, UiRuntimeCatalog } from "../shared/contracts.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import { runtimeBackendOwner, type HostRuntimeBackendProvider } from "./host-extensions.js";
import type { HostMethodContext } from "./host-jobs.js";
import { activateHostKit } from "./test-support/host-kit-harness.js";
import { gitHasMergeTree, parseGitVersion } from "../shared/host-resources.js";
import {
  HostResourceSampler,
  checkReadiness,
  createResourceMethods,
  displayReadiness,
  linuxOnBattery,
  parseMemAvailable,
  parsePmset,
  parseVmStat,
  parsePsTime,
  processTreeCpuMs,
  runtimeReadiness,
  testResourceOs,
  worktreesFolder,
  type ReadinessRuntimes,
  type ResourceOs,
} from "./host-resources.js";

const GB = 1024 ** 3;

/** Two cores whose counters the test moves by hand. */
function fakeOs(platform: NodeJS.Platform = "linux") {
  const cores = [0, 1].map(() => ({ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }));
  const os: ResourceOs = {
    platform: () => platform,
    cpus: () => cores.map((times) => ({ times: { ...times } })),
    totalmem: () => 8 * GB,
    freemem: () => 1 * GB,
  };
  /** Each core spends `busy` of `ms` working. */
  const run = (ms: number, busy: number) => {
    for (const core of cores) {
      core.user += ms * busy;
      core.idle += ms * (1 - busy);
    }
  };
  return { os, run };
}

function sampler(options: { platform?: NodeJS.Platform; available?: number; battery?: boolean } = {}) {
  const { os, run } = fakeOs(options.platform);
  let now = 1_000_000;
  const sleep = vi.fn(async (ms: number) => { run(ms, 0.25); now += ms; });
  const resources = new HostResourceSampler({
    os,
    now: () => now,
    sleep,
    availableMemory: async () => options.available,
    battery: async () => options.battery,
  });
  return { resources, sleep, run, advance: (ms: number, busy: number) => { run(ms, busy); now += ms; }, now: () => now };
}

describe("the machine's load, read when asked", () => {
  it("watches the counters for five seconds when it has no recent reading", async () => {
    const { resources, sleep, now } = sampler({ available: 3 * GB });
    const first = await resources.sample();
    expect(sleep).toHaveBeenCalledWith(5_000);
    expect(first).toEqual({ sampledAt: now(), cpuCount: 2, cpuUtilization: 0.25, totalMemory: 8 * GB, availableMemory: 3 * GB, runningTurns: 0 });
  });

  it("answers at once from the last reading while it is recent, and the same answer within five seconds", async () => {
    const { resources, sleep, advance } = sampler();
    const first = await resources.sample();
    advance(2_000, 1);
    expect(await resources.sample()).toBe(first);
    advance(8_000, 0.5);
    const next = await resources.sample();
    expect(sleep).toHaveBeenCalledTimes(1);
    // 10 s since the first reading: 2 s at 100 %, 8 s at 50 %.
    expect(next.cpuUtilization).toBeCloseTo(0.6);
    advance(60_000, 0);
    await resources.sample();
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("shares one reading between callers who ask at the same time", async () => {
    const { resources, sleep } = sampler();
    const [a, b] = await Promise.all([resources.sample(), resources.sample()]);
    expect(a).toBe(b);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("counts the threads running a turn from agent-status", async () => {
    const { resources } = sampler();
    resources.observe({ type: "agent-status", sessionId: "a", running: true });
    resources.observe({ type: "agent-status", sessionId: "b", running: true });
    resources.observe({ type: "agent-status", sessionId: "a", running: false });
    resources.observe({ type: "assistant-delta", sessionId: "c" });
    expect((await resources.sample()).runningTurns).toBe(1);
  });

  it("says on battery only where the machine can tell, and keeps os.freemem when the platform has nothing better", async () => {
    expect(await sampler({ battery: true }).resources.sample()).toMatchObject({ onBattery: true, availableMemory: GB });
    expect(await sampler({ battery: false }).resources.sample()).toMatchObject({ onBattery: false });
    expect(await sampler().resources.sample()).not.toHaveProperty("onBattery");
  });

  it("leaves CPU use out when the counters did not move", async () => {
    const { os } = fakeOs();
    const resources = new HostResourceSampler({ os, sleep: async () => undefined, availableMemory: async () => undefined, battery: async () => undefined });
    expect(await resources.sample()).not.toHaveProperty("cpuUtilization");
  });
});

describe("a test host that plays a smaller machine", () => {
  const os = { platform: () => "linux" as const, cpus: () => Array.from({ length: 12 }, () => ({ times: { user: 1, nice: 0, sys: 1, idle: 8, irq: 0 } })), totalmem: () => 8e9, freemem: () => 4e9 };

  it("has TAU_TEST_CPU_COUNT cores, and nothing changes without it", async () => {
    const ports = { treeCpuMs: () => 0, now: () => 0 };
    expect(testResourceOs({}, os, ports)).toBeUndefined();
    expect(testResourceOs({ TAU_TEST_CPU_COUNT: "0" }, os, ports)).toBeUndefined();
    const small = testResourceOs({ TAU_TEST_CPU_COUNT: "2" }, os, ports)!;
    expect(small.cpus()).toHaveLength(2);
    const reading = new HostResourceSampler({ os: small, sleep: async () => undefined, availableMemory: async () => undefined, battery: async () => undefined });
    expect((await reading.sample()).cpuCount).toBe(2);
  });

  it("counts only its own process tree as load, and a tree busier than its cores as full", async () => {
    let now = 0;
    let cpu = 0;
    const small = testResourceOs({ TAU_TEST_CPU_COUNT: "2" }, os, { treeCpuMs: () => cpu, now: () => now })!;
    const reading = new HostResourceSampler({
      os: small,
      now: () => now,
      // One busy core of two while the reading watches.
      sleep: async (ms) => { now += ms; cpu += ms; },
      availableMemory: async () => undefined,
      battery: async () => undefined,
    });
    expect((await reading.sample()).cpuUtilization).toBeCloseTo(0.5);
    now += 60_000;
    cpu += 60_000 * 5;
    const full = new HostResourceSampler({ os: small, now: () => now, sleep: async (ms) => { now += ms; cpu -= 1_000; }, availableMemory: async () => undefined, battery: async () => undefined });
    // A child that exited took its time along; the counters still do not run backwards.
    expect((await full.sample()).cpuUtilization).toBe(0);
  });

  it("adds up ps's CPU times below a process", () => {
    expect(parsePsTime("0:01.50")).toBe(1_500);
    expect(parsePsTime("1:02:03")).toBe(3_723_000);
    expect(parsePsTime("2-00:00:01")).toBe(172_801_000);
    expect(parsePsTime("soon")).toBeUndefined();
    const ps = "  1     0   9:00.00\n 10     1   0:01.00\n 11    10   0:02.50\n 12    11   1:00.00\n 20     1   5:00.00\n";
    expect(processTreeCpuMs(ps, 10)).toBe(63_500);
    expect(processTreeCpuMs(ps, 99)).toBe(0);
  });
});

describe("what each platform reports", () => {
  it("reads macOS's vm_stat as free, inactive and speculative pages", () => {
    const output = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10.\nPages active:                             99.\nPages inactive:                           20.\nPages speculative:                         5.\n";
    expect(parseVmStat(output)).toBe(35 * 16384);
    expect(parseVmStat("nonsense")).toBeUndefined();
  });

  it("reads Linux's MemAvailable", () => {
    expect(parseMemAvailable("MemTotal:  8000 kB\nMemFree:  100 kB\nMemAvailable:    4096 kB\n")).toBe(4096 * 1024);
    expect(parseMemAvailable("MemTotal:  8000 kB\n")).toBeUndefined();
  });

  it("reads pmset: a Mac without a battery has no answer", () => {
    expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging")).toBe(true);
    expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged")).toBe(false);
    expect(parsePmset("Now drawing from 'AC Power'\n")).toBeUndefined();
  });

  describe("Linux power supplies", () => {
    const dirs: string[] = [];
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
    const supplies = (entries: Record<string, { type: string; online?: string }>) => {
      const root = mkdtempSync(join(tmpdir(), "tau-power-"));
      dirs.push(root);
      for (const [name, { type, online }] of Object.entries(entries)) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, "type"), `${type}\n`);
        if (online !== undefined) writeFileSync(join(root, name, "online"), `${online}\n`);
      }
      return root;
    };

    it("is on battery with a battery and no mains online", async () => {
      expect(await linuxOnBattery(supplies({ BAT0: { type: "Battery" }, AC: { type: "Mains", online: "0" } }))).toBe(true);
      expect(await linuxOnBattery(supplies({ BAT0: { type: "Battery" }, AC: { type: "Mains", online: "1" } }))).toBe(false);
      expect(await linuxOnBattery(supplies({}))).toBeUndefined();
      expect(await linuxOnBattery(join(tmpdir(), "tau-no-such-power-supply"))).toBeUndefined();
    });
  });
});

describe("git for merge-tree", () => {
  it("reads the version and knows 2.38 checks a merge without a checkout", () => {
    expect(parseGitVersion("git version 2.39.5 (Apple Git-154)\n")).toBe("2.39.5");
    expect(parseGitVersion("git version 2.43.0\n")).toBe("2.43.0");
    expect(parseGitVersion("")).toBeUndefined();
    expect(gitHasMergeTree("2.38.0")).toBe(true);
    expect(gitHasMergeTree("3.0")).toBe(true);
    expect(gitHasMergeTree("2.37.9")).toBe(false);
    expect(gitHasMergeTree(undefined)).toBe(false);
  });
});

const PI: UiRuntimeBackend = { kind: "pi", label: "Pi" };
const CODEX: UiRuntimeBackend = { kind: "codex", label: "Codex", version: { tool: "codex", installed: "0.50.0" } };
const CLAUDE: UiRuntimeBackend = { kind: "claude-code", label: "Claude Code" };
const catalog = (kind: string, models: number, extra: Partial<UiRuntimeCatalog> = {}): UiRuntimeCatalog => ({
  kind,
  models: Array.from({ length: models }, (_, index) => ({ provider: "p", id: `m${index}`, name: `M${index}` }) as UiRuntimeCatalog["models"][number]),
  thinkingLevels: {},
  ...extra,
});

describe("which runtimes could run a thread", () => {
  it("reads each runtime's catalog: a status says why not, Pi without a model has nobody signed in", () => {
    expect(runtimeReadiness(PI, catalog("pi", 3))).toEqual({ kind: "pi", label: "Pi", state: "ready", models: 3, modelIds: ["p/m0", "p/m1", "p/m2"] });
    expect(runtimeReadiness(PI, catalog("pi", 0))).toMatchObject({ state: "sign-in-required", note: expect.stringMatching(/provider/u) });
    expect(runtimeReadiness(CODEX, catalog("codex", 0, { status: "sign-in-required", note: "Codex is not signed in." })))
      .toEqual({ kind: "codex", label: "Codex", version: "0.50.0", state: "sign-in-required", note: "Codex is not signed in." });
    expect(runtimeReadiness(CLAUDE, catalog("claude-code", 0, { status: "not-installed" }))).toMatchObject({ state: "not-installed" });
    // Some runtimes name their models only once a thread runs.
    expect(runtimeReadiness(CLAUDE, catalog("claude-code", 0))).toEqual({ kind: "claude-code", label: "Claude Code", state: "ready" });
    expect(runtimeReadiness(CLAUDE, undefined)).toMatchObject({ state: "checking" });
  });

  it("takes the kit's sign-in report: a signed-out program is not ready, a signed-in one names its account", () => {
    const antigravity: UiRuntimeBackend = { kind: "antigravity", label: "Antigravity" };
    const unknown = catalog("antigravity", 0, { note: "Antigravity names its models once a thread has started." });
    expect(runtimeReadiness(antigravity, unknown, { methods: [], account: { signedIn: false } }))
      .toEqual({ kind: "antigravity", label: "Antigravity", state: "sign-in-required", note: "Antigravity is not signed in." });
    expect(runtimeReadiness(CODEX, catalog("codex", 4), { methods: [], account: { signedIn: true, label: "me@example.com", detail: "ChatGPT Pro" } }))
      .toEqual({ kind: "codex", label: "Codex", version: "0.50.0", account: "me@example.com · ChatGPT Pro", state: "ready", models: 4, modelIds: ["p/m0", "p/m1", "p/m2", "p/m3"] });
    // The catalog's reason stands where it has one.
    expect(runtimeReadiness(CODEX, catalog("codex", 0, { status: "not-installed" }), { methods: [], account: { signedIn: false } })).toMatchObject({ state: "not-installed" });
    expect(runtimeReadiness(CODEX, undefined, { methods: [], account: { signedIn: false, detail: "Codex did not report its account within 20 s." } }))
      .toMatchObject({ state: "sign-in-required", note: "Codex did not report its account within 20 s." });
  });

  it("asks the kit that registered each backend, for its instance, and not for Pi", async () => {
    const invoked: unknown[][] = [];
    const runtimes: ReadinessRuntimes = {
      runtimeBackends: () => [PI, { kind: "codex@work", label: "Codex (work)" }, CLAUDE, { kind: "zeta", label: "Zeta" }],
      runtimeCatalogs: async () => [catalog("pi", 1), catalog("codex@work", 2), catalog("claude-code", 0), catalog("zeta", 1)],
      runtimeCatalog: async () => undefined,
      runtimeBackendOwner: (kind) => ({ "codex@work": "tau.codex", "claude-code": "tau.claude-code", zeta: "acme.zeta" } as Record<string, string>)[kind],
      invokeHostExtension: async (extensionId, command, input) => {
        invoked.push([extensionId, command, input]);
        if (extensionId === "acme.zeta") throw new Error("unknown command");
        return extensionId === "tau.claude-code" ? { methods: [], account: { signedIn: false } } : { methods: [], account: { signedIn: true, label: "work@example.com" } };
      },
    };
    const readiness = await checkReadiness(runtimes, fixed());
    expect(invoked).toEqual([["tau.codex", "sign-in-state", { target: "work" }], ["tau.claude-code", "sign-in-state", undefined], ["acme.zeta", "sign-in-state", undefined]]);
    expect(readiness.runtimes.map((runtime) => [runtime.kind, runtime.state, runtime.account])).toEqual([
      ["pi", "ready", undefined],
      ["codex@work", "ready", "work@example.com"],
      ["claude-code", "sign-in-required", undefined],
      ["zeta", "ready", undefined],
    ]);
  });

  it("knows which extension registered a backend", async () => {
    const provider = { kind: "zeta" } as HostRuntimeBackendProvider;
    const registered: HostRuntimeBackendProvider[] = [];
    await activateHostKit({
      id: "acme.zeta",
      name: "Zeta",
      permissions: ["runtime:extend"],
      activate: (context) => { context.services.registerRuntimeBackend(provider); },
    }, { registerRuntimeBackend: (entry) => { registered.push(entry); return () => undefined; } });
    expect(registered).toEqual([provider]);
    expect(runtimeBackendOwner(provider)).toBe("acme.zeta");
    expect(runtimeBackendOwner({ kind: "other" } as HostRuntimeBackendProvider)).toBeUndefined();
  });

  it("asks a runtime with no answer on hand, and does not wait long for it", async () => {
    const asked: string[] = [];
    const runtimes: ReadinessRuntimes = {
      runtimeBackends: () => [PI, CODEX, CLAUDE],
      runtimeCatalogs: vi.fn(async () => [catalog("pi", 2)]),
      runtimeCatalog: async (kind) => {
        asked.push(kind);
        return kind === "codex" ? catalog("codex", 0, { status: "sign-in-required" }) : new Promise<undefined>(() => undefined);
      },
    };
    const readiness = await checkReadiness(runtimes, fixed({ catalogWaitMs: 5 }));
    expect(runtimes.runtimeCatalogs).toHaveBeenCalledWith(true);
    expect(asked).toEqual(["codex", "claude-code"]);
    expect(readiness.runtimes.map((runtime) => [runtime.kind, runtime.state])).toEqual([["pi", "ready"], ["codex", "sign-in-required"], ["claude-code", "checking"]]);
  });
});

const NO_RUNTIMES: ReadinessRuntimes = { runtimeBackends: () => [], runtimeCatalogs: async () => [], runtimeCatalog: async () => undefined };

function fixed(options: Parameters<typeof checkReadiness>[1] = {}): Parameters<typeof checkReadiness>[1] {
  return {
    env: { TAU_WORKTREES_DIR: "/data/worktrees" },
    platform: "linux",
    now: () => 42,
    gitVersion: async () => "git version 2.43.0\n",
    statfs: async () => ({ bavail: 10, bsize: GB, blocks: 100 }),
    xServer: async () => undefined,
    ...options,
  };
}

describe("whether this machine could take on a thread", () => {
  it("reports git, the free space where worktrees go and the display", async () => {
    expect(await checkReadiness(NO_RUNTIMES, fixed())).toEqual({
      checkedAt: 42,
      runtimes: [],
      git: { version: "2.43.0", mergeTree: true },
      disk: { path: "/data/worktrees", free: 10 * GB, total: 100 * GB },
      display: { kind: "none" },
    });
  });

  it("says when there is no git or an old one", async () => {
    expect((await checkReadiness(NO_RUNTIMES, fixed({ gitVersion: async () => { throw new Error("ENOENT"); } }))).git).toEqual({ mergeTree: false });
    expect((await checkReadiness(NO_RUNTIMES, fixed({ gitVersion: async () => "git version 2.34.1" }))).git).toEqual({ version: "2.34.1", mergeTree: false });
  });

  it("measures a worktree folder not made yet on the disk of its nearest parent", async () => {
    const looked: string[] = [];
    const statfs = async (path: string) => {
      looked.push(path);
      if (path !== "/data") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { bavail: 3, bsize: GB, blocks: 9 };
    };
    expect((await checkReadiness(NO_RUNTIMES, fixed({ statfs }))).disk).toEqual({ path: "/data/worktrees", free: 3 * GB, total: 9 * GB });
    expect(looked).toEqual(["/data/worktrees", "/data"]);
    const denied = async () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); };
    expect((await checkReadiness(NO_RUNTIMES, fixed({ statfs: denied }))).disk).toEqual({ path: "/data/worktrees", error: "EACCES: permission denied" });
  });

  it("puts worktrees under Tau's folder in the home when nothing is configured", () => {
    expect(worktreesFolder({}, "/home/rex")).toBe("/home/rex/.tau");
    expect(worktreesFolder({ TAU_WORKTREES_DIR: " /w " }, "/home/rex")).toBe("/w");
  });

  it("tells a desktop's screen, an X or Wayland display, Xvfb and none apart", async () => {
    expect(await displayReadiness("darwin", {})).toEqual({ kind: "screen" });
    expect(await displayReadiness("win32", {})).toEqual({ kind: "screen" });
    expect(await displayReadiness("linux", {}, async () => undefined)).toEqual({ kind: "none" });
    expect(await displayReadiness("linux", { DISPLAY: ":0" }, async () => "Xorg")).toEqual({ kind: "x11", name: ":0" });
    expect(await displayReadiness("linux", { DISPLAY: ":99" }, async () => "Xvfb")).toEqual({ kind: "invisible", name: ":99" });
    expect(await displayReadiness("linux", { DISPLAY: ":99" }, async () => { throw new Error("no lock file"); })).toEqual({ kind: "x11", name: ":99" });
    expect(await displayReadiness("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual({ kind: "wayland", name: "wayland-0" });
    expect(await displayReadiness("linux", { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, async () => "Xwayland")).toEqual({ kind: "wayland", name: "wayland-0" });
  });
});

describe("the two host methods", () => {
  it("answers the load from the sampler, and unsupported on a host without one", async () => {
    const { resources } = sampler();
    const methods = createResourceMethods({ resources: () => resources, runtimes: async () => NO_RUNTIMES, readiness: fixed() });
    expect(await methods["host-resources"]!([])).toMatchObject({ cpuCount: 2 });
    expect(await methods.readiness!([])).toMatchObject({ checkedAt: 42, git: { mergeTree: true } });
    // Accounts are for devices that may ask sign-in-state themselves.
    const signedIn: ReadinessRuntimes = {
      runtimeBackends: () => [CODEX],
      runtimeCatalogs: async () => [catalog("codex", 1)],
      runtimeCatalog: async () => undefined,
      runtimeBackendOwner: () => "tau.codex",
      invokeHostExtension: async () => ({ methods: [], account: { signedIn: true, label: "me@example.com" } }),
    };
    const withAccounts = createResourceMethods({ runtimes: async () => signedIn, readiness: fixed() });
    const context = (principal: HostMethodContext["principal"]): HostMethodContext => ({ progress: () => undefined, signal: new AbortController().signal, principal });
    expect(await withAccounts.readiness!([], context({ kind: "workbench-client", connection: "c", pairedClient: "d" }))).toMatchObject({ runtimes: [{ account: "me@example.com" }] });
    const readOnly = await withAccounts.readiness!([], context({ kind: "workbench-client", connection: "c", pairedClient: "d", readOnly: true })) as { runtimes: object[] };
    expect(readOnly.runtimes[0]).toEqual({ kind: "codex", label: "Codex", version: "0.50.0", state: "ready", models: 1, modelIds: ["p/m0"] });
    const none = createResourceMethods({ runtimes: async () => NO_RUNTIMES });
    await expect(none["host-resources"]!([])).rejects.toMatchObject({ code: HOST_ERROR.unsupported });
  });
});
