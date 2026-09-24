import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiEnvironments } from "../shared/environments.js";
import type { SavedEnvironment, SecretBox } from "./environment-catalog.js";
import type { EnvironmentMonitor, EnvironmentMonitorOptions, MonitorState } from "./environment-monitor.js";
import type { PairEnvironmentOptions, PairEnvironmentResult } from "./environment-pairing.js";
import { CERTIFICATE_ACCEPT, CERTIFICATE_DEFAULT, CERTIFICATE_REJECT } from "./host-tls-trust.js";
import { WindowEnvironments, type EnvironmentConnection, type WindowEnvironmentsOptions } from "./window-environments.js";

const directories: string[] = [];
const opened: WindowEnvironments[] = [];
afterEach(() => {
  for (const environments of opened.splice(0)) environments.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const box: SecretBox = { available: () => true, encrypt: (text) => Buffer.from(text).toString("base64"), decrypt: (data) => Buffer.from(data, "base64").toString() };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const PIN = Array.from({ length: 32 }, () => "AB").join(":");
const OTHER = Array.from({ length: 32 }, () => "CD").join(":");

const studio: SavedEnvironment = {
  id: "host-studio",
  name: "studio",
  endpoints: [{ url: "https://192.168.1.4:7788/", kind: "lan" }, { url: "https://100.64.0.9:7788/", kind: "tailscale" }],
  fingerprint: PIN,
  token: "tau_client_studio",
  addedAt: "2026-09-24T10:00:00.000Z",
};

async function setup(pairResult?: PairEnvironmentResult, extra: Partial<WindowEnvironmentsOptions> & { directory?: string } = {}) {
  const directory = extra.directory ?? mkdtempSync(join(tmpdir(), "tau-window-environments-"));
  if (!extra.directory) directories.push(directory);
  const pairCalls: PairEnvironmentOptions[] = [];
  const monitors = new Map<string, { options: EnvironmentMonitorOptions; set(state: Partial<MonitorState>): void }>();
  const published: UiEnvironments[] = [];
  const shown: Array<EnvironmentConnection | undefined> = [];
  const environments = new WindowEnvironments({
    catalogPath: join(directory, "environments.json"),
    box,
    logger,
    deviceName: "laptop",
    local: { id: "host-laptop", name: "laptop" },
    publish: (list) => published.push(list),
    show: async (connection) => { shown.push(connection); },
    monitor: (options) => {
      const key = options.urls()[0]!;
      let state: MonitorState = { status: "connecting", running: new Set() };
      monitors.set(key, { options, set: (patch) => { state = { ...state, ...patch }; options.onChange(state); } });
      return { close: vi.fn(), retryNow: vi.fn(), get current() { return state; } } as unknown as EnvironmentMonitor;
    },
    pair: async (options: PairEnvironmentOptions) => {
      pairCalls.push(options);
      options.onWaiting?.({ address: "wss://192.168.1.4:7788/", verification: "123456", expiresAt: "later" });
      // The owner takes a moment; the page hears the digits meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 120));
      return pairResult ?? { state: "approved", environment: studio };
    },
    ...extra,
  });
  opened.push(environments);
  environments.setLocalHost("ws://127.0.0.1:5000", "host-token");
  await environments.start();
  return { environments, monitors, published, shown, pairCalls, directory };
}

describe("the machines of a window", () => {
  it("lists this machine first, always, with what its own host reports", async () => {
    const { environments, monitors } = await setup();
    monitors.get("ws://127.0.0.1:5000")!.set({
      status: "connected",
      index: { projects: [], sessions: [{ id: "t1", path: "/s/t1", title: "Local thread", modifiedAt: 5, projectPath: "/p", projectName: "p", messageCount: 2 }] },
    });
    expect(environments.snapshot()).toMatchObject({
      shown: "host-laptop",
      secureStorage: true,
      environments: [{ id: "host-laptop", name: "laptop", local: true, status: "connected", threadCount: 1, threads: [{ id: "t1", title: "Local thread" }] }],
    });
  });

  it("adds a machine the other owner allowed, shows the digits meanwhile, and starts watching it", async () => {
    const { environments, monitors, published } = await setup();
    const added = await environments.pair({ text: "https://192.168.1.4:7788/#pair=abc" });
    expect(added).toMatchObject({ state: "added", environment: { id: "host-studio", name: "studio", local: false } });
    await expect.poll(() => published.some((list) => list.pairing?.verification === "123456")).toBe(true);
    expect(environments.snapshot().pairing).toBeUndefined();
    // The LAN address first, pinned with the saved fingerprint.
    const monitor = monitors.get("wss://192.168.1.4:7788/")!;
    expect(monitor.options).toMatchObject({ token: "tau_client_studio", fingerprint: PIN });
    expect(monitor.options.urls()).toEqual(["wss://192.168.1.4:7788/", "wss://100.64.0.9:7788/"]);
  });

  it("does not save this machine as another one", async () => {
    const { environments } = await setup({ state: "approved", environment: { ...studio, id: "host-laptop" } });
    expect(await environments.pair({ text: "127.0.0.1:5000" })).toMatchObject({ state: "failed", message: expect.stringMatching(/this machine/u) });
    expect(environments.snapshot().environments).toHaveLength(1);
  });

  it("points the page at a reachable machine with its target, and back", async () => {
    const { environments, monitors, shown } = await setup();
    await environments.pair({ text: "link" });
    const monitor = monitors.get("wss://192.168.1.4:7788/")!;
    await expect(environments.open("host-studio", { thread: { path: "/s/x" } })).rejects.toThrow(/not reachable/u);
    monitor.set({ status: "connected", address: "wss://100.64.0.9:7788/" });
    await environments.open("host-studio", { thread: { path: "/s/x" } });
    expect(shown.at(-1)).toEqual({ id: "host-studio", url: "wss://100.64.0.9:7788/", token: "tau_client_studio", fingerprint: PIN });
    expect(environments.shown).toBe("host-studio");
    expect(environments.takeArrival()).toEqual({ thread: { path: "/s/x" } });
    expect(environments.takeArrival()).toBeUndefined();
    await environments.open("host-laptop");
    expect(shown.at(-1)).toBeUndefined();
    expect(environments.showsLocal).toBe(true);
  });

  it("goes back to this machine when the shown one is removed", async () => {
    const { environments, monitors, shown } = await setup();
    await environments.pair({ text: "link" });
    monitors.get("wss://192.168.1.4:7788/")!.set({ status: "connected" });
    await environments.open("host-studio");
    expect(await environments.remove("host-studio")).toBe(true);
    expect(environments.shown).toBe("host-laptop");
    expect(shown.at(-1)).toBeUndefined();
    expect(environments.snapshot().environments.map((entry) => entry.id)).toEqual(["host-laptop"]);
  });

  it("keeps an offline machine's last threads", async () => {
    const { environments, monitors } = await setup();
    await environments.pair({ text: "link" });
    const monitor = monitors.get("wss://192.168.1.4:7788/")!;
    monitor.set({ status: "connected", index: { projects: [], sessions: [{ id: "r1", path: "/r/1", title: "Remote", modifiedAt: 1, projectPath: "/q", projectName: "q", messageCount: 1 }] } });
    monitor.set({ status: "offline", index: undefined, lastSeenAt: 42 });
    expect(environments.snapshot().environments[1]).toMatchObject({ status: "offline", lastSeenAt: 42, threads: [{ id: "r1" }] });
  });

  it("trusts a saved machine's certificate for its names only, and drops the page's origin only on its sockets", async () => {
    const { environments } = await setup();
    await environments.pair({ text: "link" });
    expect(environments.certificateVerdict("192.168.1.4", PIN.toLowerCase())).toBe(CERTIFICATE_ACCEPT);
    expect(environments.certificateVerdict("192.168.1.4", OTHER)).toBe(CERTIFICATE_REJECT);
    expect(environments.certificateVerdict("example.com", OTHER)).toBe(CERTIFICATE_DEFAULT);
    expect(environments.isSavedSocket("wss://100.64.0.9:7788/")).toBe(true);
    expect(environments.isSavedSocket("wss://100.64.0.9:7789/")).toBe(false);
    expect(environments.isSavedSocket("ws://127.0.0.1:5000/")).toBe(false);
  });

  it("follows a saved machine to its new LAN address when its hello names it, keeping names and Tailscale", async () => {
    const { environments, monitors } = await setup();
    await environments.pair({ text: "link" });
    const monitor = monitors.get("wss://192.168.1.4:7788/")!;
    monitor.options.onReached!("wss://100.64.0.9:7788/", {
      protocol: 1, hostVersion: "1", capabilities: [], resync: false, missed: [], nextSeq: 0,
      host: { id: "host-studio", name: "studio", endpoints: [{ url: "https://10.0.0.8:7788/", kind: "lan" }, { url: "https://studio.local:7788/", kind: "mdns" }] },
    });
    // The address that answered stays first; the old LAN address is gone.
    await expect.poll(() => monitor.options.urls()).toEqual(["wss://100.64.0.9:7788/", "wss://10.0.0.8:7788/", "wss://studio.local:7788/"]);
    // Another machine's hello changes nothing.
    monitor.options.onReached!("wss://100.64.0.9:7788/", {
      protocol: 1, hostVersion: "1", capabilities: [], resync: false, missed: [], nextSeq: 0,
      host: { id: "someone-else", name: "x", endpoints: [{ url: "https://10.9.9.9:7788/", kind: "lan" }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(monitor.options.urls()).not.toContain("wss://10.9.9.9:7788/");
  });

  it("adds a machine a search found, pinned to its record's fingerprint, and refreshes a saved one found with its pin", async () => {
    const found = {
      serviceType: "_tau-test._tcp",
      hosts: [
        { name: "Attic", hostId: "host-attic", fingerprint: OTHER, port: 47788, addresses: ["192.168.1.9"], endpoints: [{ url: "https://192.168.1.9:47788/", kind: "lan" as const }] },
        { name: "studio", hostId: "host-studio", fingerprint: PIN, port: 7788, addresses: ["192.168.1.40"], endpoints: [{ url: "https://192.168.1.40:7788/", kind: "lan" as const }] },
        { name: "laptop", hostId: "host-laptop", fingerprint: PIN, port: 7788, addresses: ["192.168.1.2"], endpoints: [{ url: "https://192.168.1.2:7788/", kind: "lan" as const }], self: true },
      ],
    };
    const { environments, monitors, pairCalls } = await setup(undefined, { discover: async () => found });
    await environments.pair({ text: "link" });
    const monitor = monitors.get("wss://192.168.1.4:7788/")!;
    expect(await environments.discover()).toBe(found);
    expect(monitor.options.urls()).toEqual(["wss://192.168.1.40:7788/", "wss://100.64.0.9:7788/"]);
    await environments.pair({ nearby: "host-attic" });
    expect(pairCalls.at(-1)?.nearby).toEqual({ hostId: "host-attic", name: "Attic", fingerprint: OTHER, endpoints: found.hosts[0]!.endpoints });
    expect(pairCalls.at(-1)?.text).toBeUndefined();
    expect(await environments.pair({ nearby: "host-laptop" })).toMatchObject({ state: "failed", message: expect.stringMatching(/Search again/u) });
  });

  it("does not take a found machine's addresses when its certificate is not the pinned one", async () => {
    const { environments, monitors } = await setup(undefined, {
      discover: async () => ({ serviceType: "_tau-test._tcp", hosts: [{ name: "studio", hostId: "host-studio", fingerprint: OTHER, port: 7788, addresses: [], endpoints: [{ url: "https://10.6.6.6:7788/", kind: "lan" }] }] }),
    });
    await environments.pair({ text: "link" });
    await environments.discover();
    expect(monitors.get("wss://192.168.1.4:7788/")!.options.urls()).toEqual(["wss://192.168.1.4:7788/", "wss://100.64.0.9:7788/"]);
  });

  it("shows the machine it showed last again at start, when asked to and it answers in time", async () => {
    const first = await setup();
    await first.environments.pair({ text: "link" });
    await first.environments.setPreferences({ reopenShown: true });
    expect(first.environments.snapshot().reopenShown).toBe(true);
    first.monitors.get("wss://192.168.1.4:7788/")!.set({ status: "connected" });
    await first.environments.open("host-studio");
    first.environments.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const monitors = new Map<string, EnvironmentMonitorOptions>();
    const shown: Array<EnvironmentConnection | undefined> = [];
    const again = new WindowEnvironments({
      catalogPath: join(first.directory, "environments.json"),
      box, logger, deviceName: "laptop", local: { id: "host-laptop", name: "laptop" },
      publish: () => undefined,
      show: async (connection) => { shown.push(connection); },
      monitor: (options) => {
        monitors.set(options.urls()[0]!, options);
        // The saved machine answers a moment after the window starts.
        if (options.token === "tau_client_studio") setTimeout(() => options.onChange({ status: "connected", running: new Set(), address: "wss://192.168.1.4:7788/" }), 10);
        return { close: vi.fn(), retryNow: vi.fn() } as unknown as EnvironmentMonitor;
      },
    });
    opened.push(again);
    await again.start();
    expect(again.shown).toBe("host-studio");
    expect(shown).toEqual([{ id: "host-studio", url: "wss://192.168.1.4:7788/", token: "tau_client_studio", fingerprint: PIN }]);
  });

  it("starts on this machine when the one shown last does not answer in time", async () => {
    const first = await setup();
    await first.environments.pair({ text: "link" });
    await first.environments.setPreferences({ reopenShown: true });
    first.monitors.get("wss://192.168.1.4:7788/")!.set({ status: "connected" });
    await first.environments.open("host-studio");
    first.environments.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const again = await setup(undefined, { directory: first.directory, reopenWaitMs: 30 });
    expect(again.environments.shown).toBe("host-laptop");
    expect(again.shown).toEqual([]);
  });
});
