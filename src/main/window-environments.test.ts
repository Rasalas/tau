import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiEnvironments } from "../shared/environments.js";
import type { SavedEnvironment, SecretBox } from "./environment-catalog.js";
import type { EnvironmentMonitor, EnvironmentMonitorOptions, MonitorState } from "./environment-monitor.js";
import type { PairEnvironmentOptions, PairEnvironmentResult } from "./environment-pairing.js";
import { CERTIFICATE_ACCEPT, CERTIFICATE_DEFAULT, CERTIFICATE_REJECT } from "./host-tls-trust.js";
import { WindowEnvironments, type EnvironmentConnection } from "./window-environments.js";

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

async function setup(pairResult?: PairEnvironmentResult) {
  const directory = mkdtempSync(join(tmpdir(), "tau-window-environments-"));
  directories.push(directory);
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
      options.onWaiting?.({ address: "wss://192.168.1.4:7788/", verification: "123456", expiresAt: "later" });
      // The owner takes a moment; the page hears the digits meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 120));
      return pairResult ?? { state: "approved", environment: studio };
    },
  });
  opened.push(environments);
  environments.setLocalHost("ws://127.0.0.1:5000", "host-token");
  await environments.start();
  return { environments, monitors, published, shown };
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
});
