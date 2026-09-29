import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PairingEndpoint } from "../shared/connections.js";
import type { UiEnvironments } from "../shared/environments.js";
import type { SavedEnvironment, SecretBox } from "./environment-catalog.js";
import type { EnvironmentMonitor, EnvironmentMonitorOptions, MonitorState } from "./environment-monitor.js";
import type { PairEnvironmentOptions, PairEnvironmentResult } from "./environment-pairing.js";
import { CERTIFICATE_ACCEPT, CERTIFICATE_DEFAULT, CERTIFICATE_REJECT } from "./host-tls-trust.js";
import { WindowEnvironments, answerEnvironmentCommand, type EnvironmentConnection, type WindowEnvironmentsOptions } from "./window-environments.js";

const directories: string[] = [];
const opened: WindowEnvironments[] = [];
afterEach(async () => {
  const closing = opened.splice(0);
  for (const environments of closing) environments.close();
  await Promise.all(closing.map((environments) => environments.settled()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const box: SecretBox = { available: () => true, encrypt: (text) => Buffer.from(text).toString("base64"), decrypt: (data) => Buffer.from(data, "base64").toString() };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

const PIN = Array.from({ length: 32 }, () => "AB").join(":");
const OTHER = Array.from({ length: 32 }, () => "CD").join(":");
const KEY = Array.from({ length: 32 }, () => "EF").join(":");

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
  const monitors = new Map<string, {
    options: EnvironmentMonitorOptions;
    set(state: Partial<MonitorState>): void;
    calls: Array<{ method: string; params: readonly unknown[] }>;
    answers: Record<string, (params: readonly unknown[]) => unknown>;
    resubscribed: number;
  }>();
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
      const entry = {
        options,
        set: (patch: Partial<MonitorState>) => { state = { ...state, ...patch }; options.onChange(state); },
        calls: [] as Array<{ method: string; params: readonly unknown[] }>,
        answers: {} as Record<string, (params: readonly unknown[]) => unknown>,
        resubscribed: 0,
      };
      monitors.set(key, entry);
      return {
        close: vi.fn(),
        retryNow: vi.fn(),
        resubscribe: () => { entry.resubscribed += 1; },
        call: async (method: string, params: readonly unknown[] = []) => {
          entry.calls.push({ method, params });
          if (entry.answers[method]) return entry.answers[method](params);
          return { sessionId: params[0], messages: [{ id: "m1", role: "assistant", text: "hello from there" }], hasMore: false };
        },
        get current() { return state; },
      } as unknown as EnvironmentMonitor;
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
    expect(monitor.options).toMatchObject({ token: "tau_client_studio" });
    expect(monitor.options.trust!("wss://192.168.1.4:7788/")).toEqual({ pin: { fingerprint: PIN } });
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
    expect(shown.at(-1)).toEqual({ id: "host-studio", url: "wss://100.64.0.9:7788/", token: "tau_client_studio", trust: { pin: { fingerprint: PIN } } });
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
    expect(environments.certificateVerdict("192.168.1.4", { fingerprint: PIN.toLowerCase(), publicKey: OTHER })).toBe(CERTIFICATE_ACCEPT);
    expect(environments.certificateVerdict("192.168.1.4", { fingerprint: OTHER, publicKey: PIN })).toBe(CERTIFICATE_REJECT);
    expect(environments.certificateVerdict("example.com", { fingerprint: OTHER, publicKey: OTHER })).toBe(CERTIFICATE_DEFAULT);
    expect(environments.isSavedSocket("wss://100.64.0.9:7788/")).toBe(true);
    expect(environments.isSavedSocket("wss://100.64.0.9:7789/")).toBe(false);
    expect(environments.isSavedSocket("ws://127.0.0.1:5000/")).toBe(false);
  });

  it("moves a certificate pin to the key on the next hello that pin let in, and refuses a changed key from then on", async () => {
    const { environments, monitors } = await setup();
    await environments.pair({ text: "link" });
    const monitor = monitors.get("wss://192.168.1.4:7788/")!;
    const reply = { protocol: 1, hostVersion: "t", capabilities: [], resync: false, missed: [], nextSeq: 1 };
    // A CA let this one in: it proves nothing about the host's own key.
    monitor.options.onReached!("wss://192.168.1.4:7788/", reply, { presented: { fingerprint: OTHER, publicKey: OTHER }, via: "authority" });
    await environments.settled();
    expect(monitor.options.trust!("wss://192.168.1.4:7788/")).toEqual({ pin: { fingerprint: PIN } });

    monitor.options.onReached!("wss://192.168.1.4:7788/", reply, { presented: { fingerprint: PIN, publicKey: KEY }, via: "pin" });
    await expect.poll(() => monitor.options.trust!("wss://192.168.1.4:7788/")).toEqual({ pin: { publicKey: KEY } });
    expect(environments.connection("host-studio")?.trust).toEqual({ pin: { publicKey: KEY } });
    // A renewed certificate with the same key passes; another key does not.
    expect(environments.certificateVerdict("192.168.1.4", { fingerprint: OTHER, publicKey: KEY })).toBe(CERTIFICATE_ACCEPT);
    expect(environments.certificateVerdict("192.168.1.4", { fingerprint: PIN, publicKey: OTHER })).toBe(CERTIFICATE_REJECT);
  });

  it("keeps every address the machine lists after a hello, with the Serve name checked by a CA and the rest pinned", async () => {
    const { environments, monitors } = await setup({ state: "approved", environment: { ...studio, fingerprint: undefined, publicKey: KEY, endpoints: [studio.endpoints[0]!] } as SavedEnvironment });
    await environments.pair({ text: "link" });
    const monitor = monitors.get("wss://192.168.1.4:7788/")!;
    const serve = { url: "https://studio.tail0000.ts.net/", kind: "magicdns" as const, trustedCertificate: true };
    const hello = (id: string, endpoints: PairingEndpoint[]) => ({ protocol: 1, hostVersion: "1", capabilities: [], resync: false, missed: [], nextSeq: 0, host: { id, name: "studio", endpoints } });
    monitor.options.onReached!("wss://192.168.1.4:7788/", hello("someone-else", [serve]));
    await environments.settled();
    expect(monitor.options.urls()).toEqual(["wss://192.168.1.4:7788/"]);

    monitor.options.onReached!("wss://192.168.1.4:7788/", hello("host-studio", [{ url: "https://100.64.0.9:7788/", kind: "tailscale" }, serve]));
    // The address in use stays though the host did not list it; the order is the window's own.
    await expect.poll(() => monitor.options.urls()).toEqual(["wss://192.168.1.4:7788/", "wss://100.64.0.9:7788/", "wss://studio.tail0000.ts.net/"]);
    expect(monitor.options.trust!("wss://studio.tail0000.ts.net/")).toEqual({});
    expect(monitor.options.trust!("wss://100.64.0.9:7788/")).toEqual({ pin: { publicKey: KEY } });
    expect(environments.certificateVerdict("studio.tail0000.ts.net", { fingerprint: OTHER, publicKey: OTHER })).toBe(CERTIFICATE_DEFAULT);
    expect(environments.certificateVerdict("100.64.0.9", { fingerprint: OTHER, publicKey: OTHER })).toBe(CERTIFICATE_REJECT);
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
    await environments.settled();
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

  it("matches a machine pinned by key to a record with its key, whatever certificate it serves now", async () => {
    const keyed = { ...studio, fingerprint: undefined, publicKey: KEY } as SavedEnvironment;
    const record = (publicKey: string | undefined, url: string) => ({ name: "studio", hostId: "host-studio", fingerprint: OTHER, ...(publicKey ? { publicKey } : {}), port: 7788, addresses: [], endpoints: [{ url, kind: "lan" as const }] });
    let hosts = [record(OTHER, "https://10.6.6.6:7788/")];
    const { environments, monitors } = await setup({ state: "approved", environment: keyed }, { discover: async () => ({ serviceType: "_tau-test._tcp", hosts }) });
    await environments.pair({ text: "link" });
    const monitor = monitors.get("wss://192.168.1.4:7788/")!;
    await environments.discover();
    expect(monitor.options.urls()).not.toContain("wss://10.6.6.6:7788/");
    hosts = [record(undefined, "https://10.6.6.6:7788/")];
    await environments.discover();
    expect(monitor.options.urls()).not.toContain("wss://10.6.6.6:7788/");
    hosts = [record(KEY, "https://10.0.0.8:7788/")];
    await environments.discover();
    expect(monitor.options.urls()).toContain("wss://10.0.0.8:7788/");
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
    await first.environments.settled();

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
    expect(shown).toEqual([{ id: "host-studio", url: "wss://192.168.1.4:7788/", token: "tau_client_studio", trust: { pin: { fingerprint: PIN } } }]);
  });

  it("starts on this machine when the one shown last does not answer in time", async () => {
    const first = await setup();
    await first.environments.pair({ text: "link" });
    await first.environments.setPreferences({ reopenShown: true });
    first.monitors.get("wss://192.168.1.4:7788/")!.set({ status: "connected" });
    await first.environments.open("host-studio");
    first.environments.close();
    await first.environments.settled();
    const again = await setup(undefined, { directory: first.directory, reopenWaitMs: 30 });
    expect(again.environments.shown).toBe("host-laptop");
    expect(again.shown).toEqual([]);
  });

  it("hands the page a .local machine at the address this process resolved, pinned like the name", async () => {
    const local = { ...studio, endpoints: [{ url: "https://studio.local:7788/", kind: "mdns" as const }] };
    const { environments, monitors, shown } = await setup({ state: "approved", environment: local }, { resolve: async () => "192.168.1.77" });
    await environments.pair({ text: "studio.local:7788" });
    monitors.get("wss://studio.local:7788/")!.set({ status: "connected", address: "wss://studio.local:7788/" });
    await environments.open("host-studio");
    expect(shown.at(-1)?.url).toBe("wss://192.168.1.77:7788/");
    expect(environments.certificateVerdict("192.168.1.77", { fingerprint: PIN, publicKey: OTHER })).toBe(CERTIFICATE_ACCEPT);
    expect(environments.certificateVerdict("192.168.1.77", { fingerprint: OTHER, publicKey: OTHER })).toBe(CERTIFICATE_REJECT);
    expect(environments.isSavedSocket("wss://192.168.1.77:7788/")).toBe(true);
    expect(environments.isSavedSocket("wss://192.168.1.77:9999/")).toBe(false);
  });
});

describe("this computer's agents on a machine (ADR 0027)", () => {
  const agentsHost = () => ({ add: vi.fn(async (_entry: SavedEnvironment) => undefined), remove: vi.fn(async (_id: string) => undefined) });

  it("asks for the agents in the same pairing and hands their key to this machine's host, keeping its own", async () => {
    const agents = agentsHost();
    const { environments, pairCalls } = await setup({ state: "approved", environment: studio, agentsToken: "tauc.agents" }, { agents });
    const added = await environments.pair({ text: "link" });
    expect(pairCalls[0]).toMatchObject({ deviceName: "laptop", companion: "laptop · Agents" });
    expect(added).toMatchObject({ state: "added", agents: { added: true } });
    expect(agents.add).toHaveBeenCalledWith({ ...studio, token: "tauc.agents" });
    // The window keeps the device token it was given, not the agents'.
    expect(environments.connection("host-studio")?.token).toBe("tau_client_studio");
  });

  it("asks for none when told not to, or without a host of its own, and says so when the other Tau issued none", async () => {
    const agents = agentsHost();
    const off = await setup(undefined, { agents });
    expect(await off.environments.pair({ text: "link", agents: false })).not.toHaveProperty("agents");
    expect(off.pairCalls[0]).not.toHaveProperty("companion");
    expect(agents.add).not.toHaveBeenCalled();

    const windowOnly = await setup();
    await windowOnly.environments.pair({ text: "link" });
    expect(windowOnly.pairCalls[0]).not.toHaveProperty("companion");

    const older = await setup(undefined, { agents: agentsHost() });
    expect(await older.environments.pair({ text: "link" })).toMatchObject({ state: "added", agents: { added: false, message: expect.stringMatching(/pairs no agents/u) } });
  });

  it("turns the agents on for a saved machine with a pairing of their own, pinned as saved, and off again", async () => {
    const agents = agentsHost();
    const { environments, pairCalls } = await setup({ state: "approved", environment: { ...studio, token: "tauc.agents-only" } }, { agents });
    await environments.pair({ text: "link", agents: false });
    expect(await environments.setAgents("host-studio", true)).toEqual({ state: "on" });
    expect(pairCalls[1]).toMatchObject({
      deviceName: "laptop · Agents",
      nearby: { hostId: "host-studio", fingerprint: PIN, endpoints: studio.endpoints },
    });
    expect(pairCalls[1]).not.toHaveProperty("companion");
    expect(agents.add).toHaveBeenCalledWith({ ...studio, token: "tauc.agents-only" });

    expect(await environments.setAgents("host-studio", false)).toEqual({ state: "off" });
    expect(agents.remove).toHaveBeenCalledWith("host-studio");
    expect(await environments.setAgents("host-unknown", true)).toMatchObject({ state: "failed" });
  });

  it("forgets the agents' key with the machine", async () => {
    const agents = agentsHost();
    const { environments } = await setup(undefined, { agents });
    await environments.pair({ text: "link", agents: false });
    await environments.remove("host-studio");
    expect(agents.remove).toHaveBeenCalledWith("host-studio");
  });
});

describe("looking in on another machine's thread", () => {
  const index = {
    projects: [],
    sessions: [{ id: "t9", path: "/rex/sessions/t9.jsonl", title: "On rex", modifiedAt: 7, projectPath: "/w", projectName: "w", messageCount: 3, usage: { costUsd: 0.02 } }],
  } as unknown as MonitorState["index"];

  async function connectedStudio() {
    const published: unknown[] = [];
    const context = await setup(undefined, { publishThread: (view) => published.push(view) });
    await context.environments.pair({ text: "link" });
    const monitor = context.monitors.get("wss://192.168.1.4:7788/")!;
    monitor.set({ status: "connected", index, running: new Set(["t9"]) });
    return { ...context, monitor, published };
  }

  it("subscribes the machine's connection to the thread while a page renews its watch, and reads its pages there", async () => {
    const { environments, monitor } = await connectedStudio();
    expect(monitor.options.threads!()).toEqual([]);
    // By name, as a kit may name it; the view answers the id.
    const view = environments.watchThread("studio", "t9", true);
    expect(view).toMatchObject({
      machine: "host-studio",
      machineName: "studio",
      status: "connected",
      indexed: true,
      thread: { title: "On rex", path: "/rex/sessions/t9.jsonl", running: true, messageCount: 3, usage: { costUsd: 0.02 } },
      revision: 0,
    });
    expect(monitor.options.threads!()).toEqual(["t9"]);
    expect(monitor.resubscribed).toBe(1);
    // A renewal is not a new subscription.
    environments.watchThread("host-studio", "t9", true);
    expect(monitor.resubscribed).toBe(1);
    const page = await environments.transcriptPage("host-studio", "t9");
    expect(page.messages).toHaveLength(1);
    // A dialog asked before the watch began is replayed there, once.
    expect(monitor.calls).toEqual([{ method: "sync-extension-ui", params: [] }, { method: "transcript-page", params: ["t9"] }]);
    environments.watchThread("host-studio", "t9", false);
    expect(monitor.options.threads!()).toEqual([]);
    expect(monitor.resubscribed).toBe(2);
  });

  it("tells the page of every change to the thread there, and of a question it asks", async () => {
    const { environments, monitor, published } = await connectedStudio();
    environments.watchThread("host-studio", "t9", true);
    monitor.options.onPush!({ type: "assistant-delta", sessionId: "t9", id: "a", delta: "x" });
    monitor.options.onPush!({ type: "assistant-delta", sessionId: "other", id: "b", delta: "y" });
    await expect.poll(() => published.length).toBe(1);
    expect(published[0]).toMatchObject({ machine: "host-studio", sessionId: "t9", revision: 1 });
    monitor.options.onPush!({ type: "extension-ui-prompt", sessionId: "t9", prompt: { id: "q1", sessionId: "t9", kind: "select", title: "Which colour?" } });
    await expect.poll(() => published.length).toBe(2);
    expect(published[1]).toMatchObject({ asking: { id: "q1", title: "Which colour?" }, revision: 2 });
    monitor.options.onPush!({ type: "extension-ui-resolved", id: "q1", sessionId: "t9" });
    await expect.poll(() => published.length).toBe(3);
    expect(published[2]).not.toHaveProperty("asking");
    monitor.set({ status: "offline", detail: "It stopped answering.", lastSeenAt: 99 });
    await expect.poll(() => published.length).toBe(4);
    expect(published[3]).toMatchObject({ status: "offline", lastSeenAt: 99 });
    await expect(environments.transcriptPage("host-studio", "t9")).rejects.toThrow(/not reachable/u);
  });

  it("opens a thread there by its id, from the machine's index", async () => {
    const { environments, shown } = await connectedStudio();
    await environments.open("host-studio", { threadId: "t9" });
    expect(shown.at(-1)).toMatchObject({ id: "host-studio" });
    expect(environments.takeArrival()).toEqual({ thread: { path: "/rex/sessions/t9.jsonl" } });
    await expect(environments.open("host-studio", { threadId: "nope" })).rejects.toThrow(/does not list that thread/u);
  });

  it("answers a machine it does not know as unknown, and reads nothing there", async () => {
    const { environments } = await connectedStudio();
    expect(environments.watchThread("nowhere", "t1", true)).toMatchObject({ machine: "nowhere", status: "unknown", indexed: false });
    await expect(environments.transcriptPage("nowhere", "t1")).rejects.toThrow(/does not know/u);
  });
});

describe("reading a kit of another machine (API 1.15.0)", () => {
  async function connectedStudio() {
    const context = await setup();
    await context.environments.pair({ text: "link" });
    const monitor = context.monitors.get("wss://192.168.1.4:7788/")!;
    monitor.set({ status: "connected", running: new Set() });
    let readCommands = ["state", "live-frame"];
    monitor.answers["host-extensions"] = () => [{ id: "tau.preview", name: "Preview", active: true, commands: ["state", "live-frame", "input"], readCommands }];
    monitor.answers["host-extension"] = (params) => ({ answered: params });
    return { ...context, monitor, setReadCommands: (next: string[]) => { readCommands = next; } };
  }

  it("runs a command that machine registered to only read, over the window's connection there", async () => {
    const { environments, monitor } = await connectedStudio();
    await expect(environments.readExtension("studio", "tau.preview", "live-frame", { maxWidth: 320 }))
      .resolves.toEqual({ answered: ["tau.preview", "live-frame", { maxWidth: 320 }] });
    await environments.readExtension("host-studio", "tau.preview", "state");
    // The list is asked once per connection.
    expect(monitor.calls.filter((call) => call.method === "host-extensions")).toHaveLength(1);
  });

  it("refuses a command that changes something, and asks the list again only after a while", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { environments, monitor, setReadCommands } = await connectedStudio();
      await expect(environments.readExtension("studio", "tau.preview", "input", { kind: "click", x: 0.5, y: 0.5 })).rejects.toThrow(/no command tau\.preview\/input that only reads/u);
      await expect(environments.readExtension("studio", "tau.preview", "input")).rejects.toThrow(/only reads/u);
      expect(monitor.calls.filter((call) => call.method === "host-extensions")).toHaveLength(1);
      expect(monitor.calls.some((call) => call.method === "host-extension")).toBe(false);
      // A kit updated there since: its new read command counts once the list is asked again.
      setReadCommands(["state", "live-frame", "history"]);
      vi.setSystemTime(Date.now() + 11_000);
      await expect(environments.readExtension("studio", "tau.preview", "history")).resolves.toEqual({ answered: ["tau.preview", "history", undefined] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists a machine's own update, and updates it over the window's connection there (K103)", async () => {
    const { environments, monitor } = await connectedStudio();
    const status = { version: "0.7.6", phase: "available", latest: "0.7.14", channel: "stable", automatic: true, installer: "host", devicesMayInstall: true } as const;
    monitor.set({ update: status });
    expect(environments.snapshot().environments.find((entry) => entry.id === "host-studio")?.update).toEqual(status);
    monitor.answers["update-install"] = () => ({ ...status, phase: "waiting", runningTurns: 1 });
    monitor.answers["update-settings"] = (params) => ({ ...status, ...(params[0] as object) });
    await expect(environments.updateMachine("studio", "install")).resolves.toMatchObject({ phase: "waiting", runningTurns: 1 });
    await expect(environments.updateMachine("studio", { automatic: false })).resolves.toMatchObject({ automatic: false });
    expect(monitor.calls.filter((call) => call.method.startsWith("update-"))).toEqual([
      { method: "update-install", params: [] },
      { method: "update-settings", params: [{ automatic: false }] },
    ]);
    // A host too old to answer with a status says so.
    monitor.answers["update-check"] = () => ({ sessionId: "nothing like a status" });
    await expect(environments.updateMachine("studio", "check")).rejects.toThrow(/too old to update from here/u);
  });

  it("reads nothing on a machine that is not reachable or unknown", async () => {
    const { environments, monitor } = await connectedStudio();
    await expect(environments.readExtension("nowhere", "tau.preview", "state")).rejects.toThrow(/does not know/u);
    monitor.set({ status: "offline", detail: "gone" });
    await expect(environments.readExtension("studio", "tau.preview", "state")).rejects.toThrow(/not reachable/u);
  });
});

describe("core's window half for `tau machines`", () => {
  it("lists the saved machines without keys or threads, pairs with a link under a name of its own, and forgets one", async () => {
    const agents = { add: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
    const { environments, pairCalls } = await setup({ state: "approved", environment: studio, agentsToken: "tau_client_agents" }, { agents });
    const added = await answerEnvironmentCommand(environments, "pair-environment", { text: "https://192.168.1.4:7788/#pair=abc", agents: true, name: "Studio" });
    expect(added).toEqual({ state: "added", environment: { id: "host-studio", name: "Studio" }, agents: { added: true } });
    expect(pairCalls[0]).toMatchObject({ text: "https://192.168.1.4:7788/#pair=abc", companion: "laptop · Agents" });
    expect(agents.add).toHaveBeenCalledWith(expect.objectContaining({ id: "host-studio", token: "tau_client_agents" }));
    const listed = await answerEnvironmentCommand(environments, "environments", undefined);
    expect(listed).toEqual([{ id: "host-studio", name: "Studio", status: "connecting" }]);
    expect(JSON.stringify(listed)).not.toContain("tau_client");
    expect(await answerEnvironmentCommand(environments, "remove-environment", { id: "host-studio" })).toEqual({ removed: true });
    await expect(answerEnvironmentCommand(environments, "pair-environment", {})).rejects.toThrow(/pairing link/u);
    await expect(answerEnvironmentCommand(environments, "open-anything", {})).rejects.toThrow(/no service/u);
    expect(await answerEnvironmentCommand(undefined, "environments", undefined)).toBeNull();
    await expect(answerEnvironmentCommand(undefined, "pair-environment", { text: "x" })).rejects.toThrow(/keeps no machine list/u);
  });

  it("asks for no agents unless told to", async () => {
    const { environments, pairCalls } = await setup(undefined, { agents: { add: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) } });
    await answerEnvironmentCommand(environments, "pair-environment", { text: "https://192.168.1.4:7788/#pair=abc" });
    expect(pairCalls[0]?.companion).toBeUndefined();
  });
});
