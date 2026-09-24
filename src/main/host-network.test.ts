import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_NETWORK_SETTINGS, type UiNetworkSettings } from "../shared/connections.js";
import type { Interfaces } from "./host-endpoints.js";
import type { ListenerTrust } from "./host-local-files.js";
import { HostNetworkAccess, applyNetworkSettings, decodeNetworkSettingsInput, planNetworkBinds, type NetworkBind } from "./host-network.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";
import { certificateFingerprint } from "./host-tls.js";
import type { ServiceAnnouncement } from "./host-discovery.js";
import { readTauServiceTxt } from "../shared/discovery.js";

const wifi = { en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", mac: "", cidr: null }] } as unknown as Interfaces;
const tailnet = { utun4: [{ address: "100.96.0.12", family: "IPv4", internal: false, netmask: "255.255.255.255", mac: "", cidr: null }] } as unknown as Interfaces;

const directories: string[] = [];
const accesses: HostNetworkAccess[] = [];
const blockers: Server[] = [];

afterEach(async () => {
  for (const access of accesses.splice(0)) await access.close();
  for (const blocker of blockers.splice(0)) await new Promise<void>((resolve) => blocker.close(() => resolve()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "tau-network-"));
  directories.push(directory);
  return directory;
}

/** The real plan, bound on loopback: no test ever listens beyond this machine. */
function onLoopback(ports: "any" | "settings" = "any") {
  return (settings: UiNetworkSettings, interfaces: Interfaces): NetworkBind[] =>
    planNetworkBinds(settings, interfaces).map((bind) => ({ ...bind, host: "127.0.0.1", port: ports === "any" ? 0 : bind.port }));
}

/** Records what network access would announce; nothing reaches the network. */
function fakeAnnouncer() {
  const calls: Array<ServiceAnnouncement | "closed" | undefined> = [];
  let current: ServiceAnnouncement | undefined;
  return {
    calls,
    get current() { return current; },
    announcer: {
      set: async (service: ServiceAnnouncement | undefined) => { calls.push(service); current = service; },
      state: () => current ? { state: "announced" as const, name: current.name, serviceType: current.type } : undefined,
      close: async () => { calls.push("closed"); current = undefined; },
    },
  };
}

async function openAccess(options: { userData?: string; interfaces?: () => Interfaces; ports?: "any" | "settings"; web?: boolean; bonjour?: ReturnType<typeof fakeAnnouncer> } = {}) {
  const attached: Array<{ server: Server; trust: ListenerTrust; detached: boolean }> = [];
  const access = await HostNetworkAccess.open({
    userData: options.userData ?? scratch(),
    interfaces: options.interfaces ?? (() => wifi),
    plan: onLoopback(options.ports),
    attach: (server, trust) => {
      const entry = { server, trust, detached: false };
      attached.push(entry);
      return () => { entry.detached = true; };
    },
    ...(options.web ? { web: () => (_request, response) => { response.end("the web client"); } } : {}),
    ...(options.bonjour ? { bonjour: { announcer: options.bonjour.announcer, serviceType: "_tau-test._tcp", hostId: "0123456789abcdef0123456789abcdef", name: "studio.local" } } : {}),
  });
  accesses.push(access);
  return { access, attached };
}

const servedFingerprint = (port: number) => new Promise<string>((resolve, reject) => {
  const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
    resolve(socket.getPeerCertificate().fingerprint256);
    socket.end();
  });
  socket.once("error", reject);
});

describe("the listeners network access asks for", () => {
  it("are none by default", () => {
    expect(planNetworkBinds(DEFAULT_NETWORK_SETTINGS, { ...wifi, ...tailnet })).toEqual([]);
  });

  it("are one dual-stack wildcard for the local network", () => {
    expect(planNetworkBinds({ ...DEFAULT_NETWORK_SETTINGS, lan: true }, wifi)).toEqual([{ key: "lan", host: "::", port: 7788, kind: "network" }]);
  });

  it("are the Tailscale addresses alone plus the proxy listener for Tailscale, so the LAN sees no open port", () => {
    expect(planNetworkBinds({ ...DEFAULT_NETWORK_SETTINGS, tailscale: true }, { ...wifi, ...tailnet })).toEqual([
      { key: "tailscale:100.96.0.12", host: "100.96.0.12", port: 7788, kind: "network" },
      { key: "proxy", host: "127.0.0.1", port: 7789, kind: "proxy" },
    ]);
  });

  it("need no Tailscale address of their own when the wildcard already covers it", () => {
    expect(planNetworkBinds({ ...DEFAULT_NETWORK_SETTINGS, lan: true, tailscale: true }, { ...wifi, ...tailnet }).map((bind) => bind.key)).toEqual(["lan", "proxy"]);
  });
});

describe("network settings from a client", () => {
  it("take known fields in range and nothing else", () => {
    expect(decodeNetworkSettingsInput({ lan: true, port: 8443, certificate: { certPath: " /c.pem ", keyPath: "/k.pem" } }))
      .toEqual({ lan: true, port: 8443, certificate: { certPath: "/c.pem", keyPath: "/k.pem" } });
    expect(decodeNetworkSettingsInput({ certificate: null })).toEqual({ certificate: null });
    for (const bad of [{ lan: "yes" }, { port: 80 }, { port: 70000 }, { proxyPort: 1.5 }, { certificate: { certPath: "/c.pem" } }, []]) {
      expect(() => decodeNetworkSettingsInput(bad)).toThrow();
    }
  });

  it("refuse one port for both listeners and drop an own certificate on null", () => {
    expect(() => applyNetworkSettings(DEFAULT_NETWORK_SETTINGS, { proxyPort: 7788 })).toThrow(/differ/u);
    const own = applyNetworkSettings(DEFAULT_NETWORK_SETTINGS, { certificate: { certPath: "/c", keyPath: "/k" } });
    expect(applyNetworkSettings(own, { certificate: null }).certificate).toBeUndefined();
  });
});

describe("network access in a running host", () => {
  it("opens nothing and writes nothing while it is off", async () => {
    const userData = scratch();
    const { access, attached } = await openAccess({ userData });
    expect(access.state()).toMatchObject({ settings: DEFAULT_NETWORK_SETTINGS, listeners: [], problems: [] });
    expect(attached).toEqual([]);
    expect(existsSync(join(userData, "network.json"))).toBe(false);
    expect(existsSync(join(userData, "tls"))).toBe(false);
  });

  it("opens a TLS listener for the local network, keeps the setting, and a restarted host opens it again", async () => {
    const userData = scratch();
    const { access, attached } = await openAccess({ userData, web: true });
    const state = await access.update({ lan: true });
    expect(state.listeners).toEqual([{ host: "127.0.0.1", port: expect.any(Number), kind: "network" }]);
    expect(state.certificate).toMatchObject({ source: "self-signed", fingerprint: access.fingerprint });
    expect(attached.map((entry) => entry.trust)).toEqual(["network"]);
    expect(await servedFingerprint(state.listeners[0]!.port)).toBe(access.fingerprint);
    expect(statSync(join(userData, "network.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(userData, "network.json"), "utf8"))).toMatchObject({ settings: { lan: true, tailscale: false } });

    await access.close();
    const again = await openAccess({ userData });
    expect(again.access.state().listeners).toHaveLength(1);
    expect(again.access.fingerprint).toBe(state.certificate!.fingerprint);
  });

  it("closes the listener and its connections when the switch goes off", async () => {
    const { access, attached } = await openAccess();
    const { listeners } = await access.update({ lan: true });
    const off = await access.update({ lan: false });
    expect(off.listeners).toEqual([]);
    expect(off.certificate).toBeUndefined();
    expect(attached[0]!.detached).toBe(true);
    await expect(servedFingerprint(listeners[0]!.port)).rejects.toThrow();
  });

  it("serves Tailscale once it has an address, and the proxy listener as a proxy from the start", async () => {
    let interfaces: Interfaces = wifi;
    const { access, attached } = await openAccess({ interfaces: () => interfaces });
    const waiting = await access.update({ tailscale: true });
    expect(waiting.tailscaleUp).toBe(false);
    expect(waiting.listeners.map((listener) => listener.kind)).toEqual(["proxy"]);
    expect(waiting.problems.join("\n")).toMatch(/Tailscale has no address/u);
    expect(attached.map((entry) => entry.trust)).toEqual(["proxy"]);

    interfaces = { ...wifi, ...tailnet };
    await access.poll();
    const up = access.state();
    expect(up.tailscaleUp).toBe(true);
    expect(up.problems).toEqual([]);
    expect(up.listeners.map((listener) => listener.kind).sort()).toEqual(["network", "proxy"]);
    expect(attached.map((entry) => entry.trust)).toEqual(["proxy", "network"]);

    interfaces = wifi;
    await access.poll();
    expect(access.state().listeners.map((listener) => listener.kind)).toEqual(["proxy"]);
    expect(attached[1]!.detached).toBe(true);
  });

  it("says which port is taken and never opens a plaintext listener instead", async () => {
    const blocker = createServer();
    blockers.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const taken = (blocker.address() as { port: number }).port;
    const { access, attached } = await openAccess({ ports: "settings" });
    const state = await access.update({ lan: true, port: taken, proxyPort: taken === 65535 ? 65534 : taken + 1 });
    expect(state.listeners).toEqual([]);
    expect(state.problems).toEqual([`The listener on 127.0.0.1, port ${taken}, did not open: another program uses port ${taken}.`]);
    expect(attached).toEqual([]);
  });

  it("refuses a certificate of the user's own that does not load, and keeps what it had", async () => {
    const userData = scratch();
    const { access } = await openAccess({ userData });
    await access.update({ lan: true });
    const before = access.fingerprint;
    writeFileSync(join(userData, "cert.pem"), "not a certificate");
    await expect(access.update({ certificate: { certPath: join(userData, "cert.pem"), keyPath: join(userData, "key.pem") } })).rejects.toThrow();
    expect(access.state().settings.certificate).toBeUndefined();
    expect(access.fingerprint).toBe(before);
  });

  it("serves a certificate of the user's own and picks up its renewal without closing the listener", async () => {
    const userData = scratch();
    const write = (name: string, stamp: number) => {
      const { cert, key } = createSelfSignedCertificate({ commonName: name, dnsNames: ["box.example"], ipAddresses: [], days: 90 });
      writeFileSync(join(userData, "cert.pem"), cert);
      writeFileSync(join(userData, "key.pem"), key, { mode: 0o600 });
      utimesSync(join(userData, "cert.pem"), stamp, stamp);
      utimesSync(join(userData, "key.pem"), stamp, stamp);
      return certificateFingerprint(cert);
    };
    const first = write("first", 1_700_000_000);
    const { access, attached } = await openAccess({ userData });
    const state = await access.update({ lan: true, certificate: { certPath: join(userData, "cert.pem"), keyPath: join(userData, "key.pem") } });
    expect(state.certificate).toMatchObject({ source: "supplied", fingerprint: first });
    const port = state.listeners[0]!.port;
    expect(await servedFingerprint(port)).toBe(first);

    const second = write("second", 1_700_000_100);
    await access.poll();
    expect(access.fingerprint).toBe(second);
    expect(await servedFingerprint(port)).toBe(second);
    expect(attached.filter((entry) => !entry.detached)).toHaveLength(1);

    const third = write("third", 1_700_000_200);
    expect(await access.reloadCertificate()).toMatchObject({ changed: true });
    expect(await servedFingerprint(port)).toBe(third);
  });
});

describe("the Bonjour announcement", () => {
  it("goes up with the local network listener: its real port, the host id and the certificate it serves", async () => {
    const bonjour = fakeAnnouncer();
    const { access } = await openAccess({ bonjour });
    expect(bonjour.current).toBeUndefined();
    const state = await access.update({ lan: true });
    const port = state.listeners[0]!.port;
    expect(bonjour.current).toEqual({ type: "_tau-test._tcp", name: "studio", port, txt: expect.any(Object) });
    expect(readTauServiceTxt(bonjour.current!.txt)).toEqual({ hostId: "0123456789abcdef0123456789abcdef", fingerprint: await servedFingerprint(port) });
    expect(state.announcement).toEqual({ state: "announced", name: "studio", serviceType: "_tau-test._tcp" });
  });

  it("stays down for Tailscale alone, with the switch off, and once Local network goes off", async () => {
    const bonjour = fakeAnnouncer();
    const { access } = await openAccess({ bonjour, interfaces: () => ({ ...wifi, ...tailnet }) });
    await access.update({ tailscale: true });
    expect(bonjour.current).toBeUndefined();
    await access.update({ lan: true, announce: false });
    expect(bonjour.current).toBeUndefined();
    await access.update({ announce: true });
    expect(bonjour.current).toBeDefined();
    await access.update({ lan: false });
    expect(bonjour.current).toBeUndefined();
  });

  it("follows a renewed certificate", async () => {
    const userData = scratch();
    const write = (name: string, stamp: number) => {
      const { cert, key } = createSelfSignedCertificate({ commonName: name, dnsNames: ["box.example"], ipAddresses: [], days: 90 });
      writeFileSync(join(userData, "cert.pem"), cert);
      writeFileSync(join(userData, "key.pem"), key, { mode: 0o600 });
      utimesSync(join(userData, "cert.pem"), stamp, stamp);
      utimesSync(join(userData, "key.pem"), stamp, stamp);
      return certificateFingerprint(cert);
    };
    write("first", 1_700_000_000);
    const bonjour = fakeAnnouncer();
    const { access } = await openAccess({ userData, bonjour });
    await access.update({ lan: true, certificate: { certPath: join(userData, "cert.pem"), keyPath: join(userData, "key.pem") } });
    const second = write("second", 1_700_000_100);
    await access.reloadCertificate();
    expect(readTauServiceTxt(bonjour.current!.txt)?.fingerprint).toBe(second);
  });

  it("is withdrawn before the listener closes when Local network goes off", async () => {
    const bonjour = fakeAnnouncer();
    const { access, attached } = await openAccess({ bonjour });
    await access.update({ lan: true });
    let detachedWhenWithdrawn: boolean | undefined;
    const set = bonjour.announcer.set;
    bonjour.announcer.set = async (service) => {
      if (!service && detachedWhenWithdrawn === undefined) detachedWhenWithdrawn = attached[0]!.detached;
      await set(service);
    };
    await access.update({ lan: false });
    expect(detachedWhenWithdrawn).toBe(false);
    expect(attached[0]!.detached).toBe(true);
  });

  it("is withdrawn before the listeners close", async () => {
    const bonjour = fakeAnnouncer();
    const { access, attached } = await openAccess({ bonjour });
    await access.update({ lan: true });
    let detachedWhenClosed: boolean | undefined;
    const close = bonjour.announcer.close;
    bonjour.announcer.close = async () => { detachedWhenClosed = attached[0]!.detached; await close(); };
    await access.close();
    expect(detachedWhenClosed).toBe(false);
    expect(bonjour.calls.at(-1)).toBe("closed");
  });

  it("is on for new settings and off for settings written before it existed, so no host start asks macOS unprompted", async () => {
    expect(DEFAULT_NETWORK_SETTINGS.announce).toBe(true);
    const userData = scratch();
    const first = await openAccess({ userData });
    await first.access.update({ lan: true });
    await first.access.close();
    const path = join(userData, "network.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as { settings: Record<string, unknown> };
    delete stored.settings.announce;
    writeFileSync(path, JSON.stringify(stored));
    const bonjour = fakeAnnouncer();
    const { access } = await openAccess({ userData, bonjour });
    expect(access.state().settings).toMatchObject({ lan: true, announce: false });
    expect(access.state().listeners).toHaveLength(1);
    expect(bonjour.current).toBeUndefined();
  });

  it("takes the switch as true or false only", () => {
    expect(decodeNetworkSettingsInput({ announce: false })).toEqual({ announce: false });
    expect(() => decodeNetworkSettingsInput({ announce: "yes" })).toThrow(/announce/u);
  });
});
