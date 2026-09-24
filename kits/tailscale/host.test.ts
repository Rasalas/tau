import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostExtension, HostNetworkServices, UiHostEndpoint, UiNetworkAccess } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createTailscaleHostExtension, type TailscaleHostOptions } from "./host.js";
import { TAILSCALE_EXTENSION_ID, type TailscaleView } from "./protocol.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-tailscale.mjs", import.meta.url));
const NAME = "tau-test-box.tail0000.ts.net";

let root: string;
let fakeState: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tau-tailscale-"));
  fakeState = join(root, "fake");
  // The fake reads its folder from the environment the kit's spawn inherits.
  process.env.FAKE_TAILSCALE_STATE = fakeState;
  process.env.FAKE_TAILSCALE_LOW_PORT_BASE = "40000";
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  // Stops any stand-in Serve the test left running.
  spawnSync(process.execPath, [FAKE, "serve", "reset"], { env: process.env });
  delete process.env.FAKE_TAILSCALE_STATE;
  rmSync(root, { recursive: true, force: true });
});

function fake(state: Record<string, unknown>): void {
  spawnSync(process.execPath, [FAKE, "status", "--json"], { env: process.env });
  const file = join(fakeState, "state.json");
  const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : {};
  writeFileSync(file, JSON.stringify({ ...current, ...state }));
  rmSync(join(fakeState, "calls.log"), { force: true });
}

function calls(): string[][] {
  const file = join(fakeState, "calls.log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
}

/** The host's side of network access: a proxy listener that opens while held or kept, unless its port is taken. */
function fakeNetwork(options: { proxyOpens?: boolean; none?: boolean } = {}) {
  let live = 0;
  let kept = false;
  const held = () => live + (kept ? 1 : 0);
  const published: UiHostEndpoint[][] = [];
  const state = (): UiNetworkAccess => ({
    settings: { lan: false, tailscale: false, port: 7788, proxyPort: 7789 },
    listeners: held() > 0 && options.proxyOpens !== false ? [{ host: "127.0.0.1", port: 7789, kind: "proxy" }] : [],
    problems: held() > 0 && options.proxyOpens === false ? ["The proxy listener on 127.0.0.1:7789 did not open: another program uses port 7789."] : [],
    tailscaleUp: true,
    ...(held() > 0 ? { proxyHeld: true } : {}),
  });
  const services: HostNetworkServices = {
    state: () => options.none ? undefined : state(),
    holdProxy: async () => {
      if (options.none) throw new Error("This host opens no listeners of its own.");
      live += 1;
      let released = false;
      return () => { if (!released) { released = true; live -= 1; } };
    },
    keepProxy: async (keep) => {
      if (options.none) throw new Error("This host opens no listeners of its own.");
      kept = keep;
    },
    publishEndpoints: (endpoints) => {
      const entry = [...endpoints];
      published.push(entry);
      return () => { published.splice(published.indexOf(entry), 1); };
    },
  };
  return { services, published, holds: held, kept: () => kept };
}

async function kit(network = fakeNetwork(), options: TailscaleHostOptions & { command?: string | null } = {}) {
  const { command = FAKE, ...rest } = options;
  const logs: string[] = [];
  const registry = await activateHostKit(createTailscaleHostExtension({ platform: "darwin", env: command ? { TAU_TAILSCALE_COMMAND: command } : {}, ...rest }) as unknown as HostExtension, {
    stateDir: join(root, "state"),
    findCommand: () => undefined,
    network: network.services,
    log: (label: string, detail?: string) => { logs.push(`${label} ${detail ?? ""}`.trim()); },
  } as never);
  cleanups.push(() => registry.dispose());
  const invoke = (name: string, input?: unknown) => registry.invoke(TAILSCALE_EXTENSION_ID, name, input) as Promise<TailscaleView>;
  return { registry, invoke, network, logs };
}

const SERVED: UiHostEndpoint = { url: `https://${NAME}/`, label: "Tailscale HTTPS", reachability: "network", kind: "magicdns", trustedCertificate: true };

describe("finding Tailscale", () => {
  it("says so where the host opens no listeners or no CLI is found", async () => {
    await expect((await kit(fakeNetwork({ none: true }))).invoke("status")).resolves.toMatchObject({ state: "no-host-network" });
    await expect((await kit(fakeNetwork(), { command: null })).invoke("status")).resolves.toMatchObject({ state: "not-installed" });
  });

  it("finds the macOS app's CLI when none is on PATH", async () => {
    const asked: string[] = [];
    const registry = await activateHostKit(createTailscaleHostExtension({ platform: "darwin", env: {} }) as unknown as HostExtension, {
      stateDir: join(root, "state"),
      findCommand: (name: string) => { asked.push(name); return undefined; },
      network: fakeNetwork().services,
      log: () => undefined,
    } as never);
    cleanups.push(() => registry.dispose());
    await registry.invoke(TAILSCALE_EXTENSION_ID, "status");
    expect(asked).toEqual(["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
  });

  it("reads only `status --json` while the tailnet has HTTPS certificates off", async () => {
    fake({ https: false });
    const view = await (await kit()).invoke("status");
    expect(view).toMatchObject({ state: "running", dnsName: NAME, magicDns: true, https: false, serve: { on: false, httpsPort: 443 } });
    expect(calls()).toEqual([["status", "--json"]]);
  });

  it("names a client that is signed out", async () => {
    fake({ backendState: "NeedsLogin" });
    await expect((await kit()).invoke("status")).resolves.toMatchObject({ state: "needs-login" });
  });
});

describe("setting up Tailscale HTTPS", () => {
  it("forwards the machine's name to the proxy listener, holds it, publishes the URL and keeps it across a restart", async () => {
    fake({});
    const first = await kit();
    const view = await first.invoke("serve-on", { httpsPort: 443, name: NAME });
    expect(view).toMatchObject({ serve: { on: true, httpsPort: 443, url: `https://${NAME}/` }, proxyListening: true });
    expect(calls()).toContainEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:7789"]);
    expect(first.network.holds()).toBe(1);
    expect(first.network.published).toEqual([[SERVED]]);
    expect(first.logs).toContain("tailscale.serve-on --https=443 http://127.0.0.1:7789");

    await first.registry.dispose();
    // Kept for the next start, when the host opens it before any kit runs.
    expect(first.network.kept()).toBe(true);
    expect(first.network.published).toEqual([]);
    rmSync(join(fakeState, "calls.log"), { force: true });
    const again = await kit(first.network);
    await expect.poll(() => again.network.published).toEqual([[SERVED]]);
    expect(again.network.kept()).toBe(true);
    expect(calls()).toEqual([]);
  });

  it("lets the host stop keeping the listener when no mapping is recorded any more", async () => {
    const network = fakeNetwork();
    await network.services.keepProxy(true);
    await kit(network);
    await expect.poll(() => network.kept()).toBe(false);
  });

  it("refuses a name other than the one the owner agreed to publish", async () => {
    fake({});
    await expect((await kit()).invoke("serve-on", { httpsPort: 443, name: "old-name.tail0000.ts.net" })).rejects.toThrow(/now called tau-test-box/u);
    expect(calls().some((call) => call[1] === "--bg")).toBe(false);
  });

  it("refuses while HTTPS certificates are off, before Tailscale could ask and wait", async () => {
    fake({ https: false });
    await expect((await kit()).invoke("serve-on", { httpsPort: 443, name: NAME })).rejects.toThrow(/HTTPS certificates are off/u);
    expect(calls()).toEqual([["status", "--json"]]);
  });

  it("never takes over a port another program is served on", async () => {
    fake({ serve: { TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } } } } });
    const { invoke, network } = await kit();
    await expect(invoke("serve-on", { httpsPort: 443, name: NAME })).rejects.toThrow(`Serve already forwards https://${NAME}/ to http://127.0.0.1:3773`);
    expect(network.holds()).toBe(0);
    const view = await invoke("serve-on", { httpsPort: 48443, name: NAME });
    expect(view.serve).toEqual({ on: true, httpsPort: 48443, url: `https://${NAME}:48443/`, others: [{ httpsPort: 443, path: "/", target: "http://127.0.0.1:3773" }] });
  });

  it("lets go of the proxy listener when Tailscale refuses, and words a Linux operator's fix", async () => {
    fake({});
    process.env.FAKE_TAILSCALE_DENY = "1";
    cleanups.push(() => { delete process.env.FAKE_TAILSCALE_DENY; });
    const { invoke, network } = await kit(fakeNetwork(), { platform: "linux" });
    await expect(invoke("serve-on", { httpsPort: 443, name: NAME })).rejects.toThrow("sudo tailscale set --operator=$USER");
    expect(network.holds()).toBe(0);
    expect(network.published).toEqual([]);
  });

  it("does not ask Tailscale when the proxy listener cannot open", async () => {
    fake({});
    const { invoke, network } = await kit(fakeNetwork({ proxyOpens: false }));
    await expect(invoke("serve-on", { httpsPort: 443, name: NAME })).rejects.toThrow("another program uses port 7789");
    expect(network.holds()).toBe(0);
    expect(calls().some((call) => call.includes("--bg"))).toBe(false);
  });

  it("takes up a mapping to Tau that was already there", async () => {
    fake({ serve: { TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7789" } } } } } });
    const { invoke, network } = await kit();
    await expect(invoke("status")).resolves.toMatchObject({ serve: { on: true, url: `https://${NAME}/` }, notice: expect.stringMatching(/already forwarded/u) });
    expect(network.published).toEqual([[SERVED]]);
  });
});

describe("turning Tailscale HTTPS off", () => {
  it("removes Tau's path only, lets go of the listener and withdraws the URL", async () => {
    fake({});
    const { invoke, network } = await kit();
    await invoke("serve-on", { httpsPort: 443, name: NAME });
    const view = await invoke("serve-off");
    expect(view.serve).toMatchObject({ on: false });
    expect(calls()).toContainEqual(["serve", "--https=443", "--set-path=/", "off"]);
    expect(network.holds()).toBe(0);
    expect(network.published).toEqual([]);
    expect(existsSync(join(root, "state", "serve.json"))).toBe(false);
  });

  it("notices a mapping removed outside Tau", async () => {
    fake({});
    const { invoke, network } = await kit();
    await invoke("serve-on", { httpsPort: 443, name: NAME });
    spawnSync(process.execPath, [FAKE, "serve", "reset"], { env: process.env });
    await expect(invoke("status")).resolves.toMatchObject({ serve: { on: false }, notice: expect.stringMatching(/turned off outside Tau/u) });
    expect(network.holds()).toBe(0);
  });
});

describe("the fake Serve in front of the proxy listener", () => {
  let backend: Server | undefined;
  afterEach(async () => { await new Promise<void>((resolve) => backend ? backend.close(() => resolve()) : resolve()); backend = undefined; });

  it("keeps the Host, sets the forwarded headers afresh and names the tailnet user, as Serve does", async () => {
    const seen: IncomingHttpHeaders[] = [];
    backend = createServer((incoming, response) => { seen.push(incoming.headers); response.end("tau"); });
    await new Promise<void>((resolve) => backend!.listen(0, "127.0.0.1", () => resolve()));
    const backendPort = (backend.address() as { port: number }).port;
    fake({ user: { loginName: "jürgen@example.com", displayName: "Jürgen", profilePicURL: "" } });
    const network = fakeNetwork();
    network.services.state = () => ({ settings: { lan: false, tailscale: false, port: 7788, proxyPort: backendPort }, listeners: [{ host: "127.0.0.1", port: backendPort, kind: "proxy" }], problems: [], tailscaleUp: true });
    const { invoke } = await kit(network);
    await invoke("serve-on", { httpsPort: 48443, name: NAME });
    await expect.poll(() => get(48443, { host: `${NAME}:48443`, "tailscale-user-login": "mallory@example.com", "x-forwarded-for": "6.6.6.6" }).catch(() => undefined), { timeout: 5_000 }).toBe("tau");
    expect(seen.at(-1)).toMatchObject({
      host: `${NAME}:48443`,
      "x-forwarded-host": `${NAME}:48443`,
      "x-forwarded-proto": "https",
      "x-forwarded-for": "100.101.102.103",
      "tailscale-user-login": "=?utf-8?q?j=C3=BCrgen@example.com?=",
    });
  });
});

function get(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path: "/", headers }, (response) => {
      let body = "";
      response.on("data", (chunk: Buffer) => { body += String(chunk); });
      response.on("end", () => resolve(body));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}
