import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type ClientOptions } from "ws";
import { HOST_TRANSPORT_VERSION, decodeHostServerFrame, type HostServerFrame } from "../shared/host-transport.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";
import { certificateFingerprint } from "./host-tls.js";
import {
  CERTIFICATE_ACCEPT,
  CERTIFICATE_DEFAULT,
  CERTIFICATE_REJECT,
  HostCertificateRefusedError,
  HostTrustError,
  KnownHosts,
  certificateRefusalMessage,
  certificateVerdict,
  establishHostTrust,
  hostEndpoint,
  pinnedTlsConnect,
  probeHostCertificate,
  type PresentedCertificate,
} from "./host-tls-trust.js";
import { assertListenAllowed } from "./host-listen.js";
import { HostClientRegistry } from "./host-clients.js";
import { HostPushLog } from "./host-push-log.js";
import { HostUplink } from "./host-uplink.js";
import { createWebClientServer } from "./host-web-server.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import type { HostMethodTable } from "./host-methods.js";

const TOKEN = "c".repeat(64);
const methods: HostMethodTable = { ping: async (params) => ({ echo: params[0] }) };
const tls = createSelfSignedCertificate({ commonName: "Tau host", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], days: 30 });
const FINGERPRINT = certificateFingerprint(tls.cert);
const OTHER = certificateFingerprint(createSelfSignedCertificate({ commonName: "Impostor", dnsNames: [], ipAddresses: [], days: 1 }).cert);

let transport: SocketHostTransport | undefined;
const sockets: WebSocket[] = [];
const uplinks: HostUplink[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const uplink of uplinks.splice(0)) uplink.close();
  await transport?.close();
  transport = undefined;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Only ever 127.0.0.1: a test never binds beyond loopback.
async function listenTls(options: { clients?: HostClientRegistry; pushLog?: HostPushLog } = {}) {
  const pushLog = options.pushLog ?? new HostPushLog();
  transport = await startSocketHostTransport({
    listen: "127.0.0.1:0",
    methods,
    pushLog,
    hostVersion: "test",
    capabilities: ["jobs", "replay"],
    token: TOKEN,
    tls,
    ...(options.clients ? { clients: options.clients } : {}),
  });
  return { transport, pushLog, url: `wss://127.0.0.1:${transport.port}` };
}

function pinned(url: string, fingerprint: string): WebSocket {
  const socket = new WebSocket(url, { createConnection: pinnedTlsConnect(fingerprint) as unknown as ClientOptions["createConnection"] });
  sockets.push(socket);
  return socket;
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function nextFrame(socket: WebSocket): Promise<HostServerFrame> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      const frame = decodeHostServerFrame(JSON.parse(String(data)) as unknown);
      if (frame) resolve(frame); else reject(new Error(`undecodable frame: ${String(data)}`));
    });
    socket.once("close", (code) => reject(new Error(`closed ${code}`)));
  });
}

async function hello(url: string, token: string, lastSeq?: number) {
  const socket = pinned(url, FINGERPRINT);
  await opened(socket);
  socket.send(JSON.stringify({ type: "hello", id: "h", hello: { protocol: HOST_TRANSPORT_VERSION, token, ...(lastSeq === undefined ? {} : { lastSeq }) } }));
  return { socket, frame: nextFrame(socket) };
}

describe("the socket transport over TLS", () => {
  it("completes a handshake with the pinned certificate and serves the protocol", async () => {
    const { url, transport: started } = await listenTls();
    expect(started.scheme).toBe("wss");
    expect(started.warning).toBeUndefined();
    const { socket, frame } = await hello(url, TOKEN);
    expect((await frame).type).toBe("hello-reply");
    socket.send(JSON.stringify({ type: "request", request: { id: "r1", method: "ping", params: ["over tls"] } }));
    expect(await nextFrame(socket)).toMatchObject({ type: "response", response: { id: "r1", result: { echo: "over tls" } } });
  });

  it("still requires the token: TLS changes nothing about authentication", async () => {
    const clients = new HostClientRegistry();
    const { url } = await listenTls({ clients });
    const wrong = await hello(url, "d".repeat(64));
    void wrong.frame.catch(() => undefined);
    expect(await new Promise((resolve) => wrong.socket.once("close", resolve))).toBe(4401);
    expect(clients.count()).toBe(0);
  });

  it("refuses another certificate before the socket opens, so no hello and no token leave", async () => {
    const clients = new HostClientRegistry();
    const { url } = await listenTls({ clients });
    const socket = pinned(url, OTHER);
    let didOpen = false;
    socket.once("open", () => { didOpen = true; });
    const error = await new Promise<Error>((resolve) => socket.once("error", resolve));
    expect(error).toBeInstanceOf(HostCertificateRefusedError);
    expect((error as HostCertificateRefusedError).presented).toBe(FINGERPRINT);
    expect((error as HostCertificateRefusedError).expected).toBe(OTHER);
    expect(didOpen).toBe(false);
    expect(clients.count()).toBe(0);
  });

  it("does not speak plaintext on a TLS port", async () => {
    const { transport: started } = await listenTls();
    const plain = new WebSocket(`ws://127.0.0.1:${started.port}`);
    sockets.push(plain);
    await expect(opened(plain)).rejects.toBeTruthy();
  });

  it("replays what a reconnect missed, as it does in plaintext", async () => {
    const { url, transport: started, pushLog } = await listenTls();
    const first = await hello(url, TOKEN);
    await first.frame;
    const push = nextFrame(first.socket);
    started.deliver(pushLog.record({ type: "event-log", label: "live", timestamp: 0 }));
    expect(await push).toMatchObject({ type: "push", push: { seq: 1 } });
    first.socket.close();
    started.deliver(pushLog.record({ type: "event-log", label: "missed-1", timestamp: 0 }));
    started.deliver(pushLog.record({ type: "event-log", label: "missed-2", timestamp: 0 }));
    const again = await hello(url, TOKEN, 1);
    const reply = await again.frame;
    expect(reply.type === "hello-reply" && reply.reply.missed.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(reply.type === "hello-reply" && reply.reply.resync).toBe(false);
  });

  it("carries the window process's uplink with a pin, and stops it for good on a mismatch", async () => {
    const { url } = await listenTls();
    const good = new HostUplink({ url, token: TOKEN, fingerprint: FINGERPRINT });
    uplinks.push(good);
    expect(await good.request("ping", ["uplink"])).toEqual({ echo: "uplink" });

    const refusals: HostCertificateRefusedError[] = [];
    const bad = new HostUplink({ url, token: TOKEN, fingerprint: OTHER, onCertificateRefused: (error) => refusals.push(error) });
    uplinks.push(bad);
    await expect(bad.request("ping", ["never"])).rejects.toThrow(/dropped/u);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.presented).toBe(FINGERPRINT);
  });

  it("serves the web client over HTTPS on the same port as the protocol", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-web-tls-"));
    directories.push(dir);
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Tau</title>");
    const web = createWebClientServer({ dir, tls });
    transport = await startSocketHostTransport({
      listen: "127.0.0.1:0", methods, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [], token: TOKEN, tls, attachTo: web.server,
    });
    const port = transport.port;
    const body = await new Promise<string>((resolve, reject) => {
      httpsGet({ host: "127.0.0.1", port, path: "/", ca: tls.cert }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += String(chunk); });
        response.on("end", () => resolve(text));
      }).on("error", reject);
    });
    expect(body).toContain("<title>Tau</title>");
    const { frame } = await hello(`wss://127.0.0.1:${port}`, TOKEN);
    expect((await frame).type).toBe("hello-reply");
  });

  it("refuses to attach TLS to a plain HTTP server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-web-plain-"));
    directories.push(dir);
    const web = createWebClientServer({ dir });
    await expect(startSocketHostTransport({
      listen: "127.0.0.1:0", methods, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [], token: TOKEN, tls, attachTo: web.server,
    })).rejects.toThrow(/plain HTTP server/u);
  });
});

describe("the listen policy with TLS", () => {
  const publicAddress = { host: "0.0.0.0", port: 7788 };

  it("lets an encrypted listener bind any interface without a warning", () => {
    expect(assertListenAllowed(publicAddress, { encrypted: true, insecure: false })).toEqual({});
  });

  it("refuses a plaintext public listener and names TLS as the way out", () => {
    expect(() => assertListenAllowed(publicAddress, { encrypted: false, insecure: false })).toThrow(/TAU_HOST_TLS=1/u);
  });

  it("answers the insecure opt-in with a warning to print, not silence", () => {
    const { warning } = assertListenAllowed(publicAddress, { encrypted: false, insecure: true });
    expect(warning).toMatch(/TAU_HOST_INSECURE=1.*without TLS.*clear text/su);
    expect(assertListenAllowed({ host: "127.0.0.1", port: 1 }, { encrypted: false, insecure: true })).toEqual({});
  });
});

describe("trusting a remote host", () => {
  const known = (): KnownHosts => {
    const directory = mkdtempSync(join(tmpdir(), "tau-known-"));
    directories.push(directory);
    return new KnownHosts(join(directory, "known-hosts.json"));
  };
  const presented = (overrides: Partial<PresentedCertificate> = {}): PresentedCertificate => ({
    fingerprint: FINGERPRINT, authorized: false, subject: "CN=Tau host", validTo: "", ...overrides,
  });
  const neverAsked = async () => { throw new Error("the user should not have been asked"); };

  it("reads the certificate a host presents without saying anything", async () => {
    const { url } = await listenTls();
    const certificate = await probeHostCertificate(url);
    expect(certificate).toMatchObject({ fingerprint: FINGERPRINT, authorized: false, subject: "CN=Tau host" });
  });

  it("treats ws: as plaintext and asks nobody", async () => {
    expect(await establishHostTrust("ws://127.0.0.1:7788", { knownHosts: known(), confirm: neverAsked })).toEqual({ kind: "plain" });
  });

  it("pins what TAU_HOST_FINGERPRINT says, and refuses a malformed one", async () => {
    const trust = await establishHostTrust("wss://Box.example:7788", {
      knownHosts: known(), confirm: neverAsked, fingerprint: FINGERPRINT.replace(/:/gu, "").toLowerCase(),
    });
    expect(trust).toEqual({ kind: "pinned", hostname: "box.example", fingerprint: FINGERPRINT, source: "environment" });
    await expect(establishHostTrust("wss://box.example:7788", { knownHosts: known(), confirm: neverAsked, fingerprint: "abc" }))
      .rejects.toBeInstanceOf(HostTrustError);
  });

  it("asks once for an unknown self-signed host, remembers a yes 0o600, and pins it", async () => {
    const knownHosts = known();
    const asked: string[] = [];
    const trust = await establishHostTrust("wss://127.0.0.1:7788", {
      knownHosts,
      probe: async () => presented(),
      confirm: async ({ endpoint, presented: certificate }) => { asked.push(`${endpoint.key} ${certificate.fingerprint}`); return true; },
    });
    expect(asked).toEqual([`127.0.0.1:7788 ${FINGERPRINT}`]);
    expect(trust).toMatchObject({ kind: "pinned", fingerprint: FINGERPRINT, source: "confirmed" });
    expect(statSync(knownHosts.path).mode & 0o777).toBe(0o600);

    const again = await establishHostTrust("wss://127.0.0.1:7788", { knownHosts, probe: neverAsked, confirm: neverAsked });
    expect(again).toMatchObject({ kind: "pinned", fingerprint: FINGERPRINT, source: "known-host" });
  });

  it("does not connect when the user declines, and remembers nothing", async () => {
    const knownHosts = known();
    await expect(establishHostTrust("wss://127.0.0.1:7788", { knownHosts, probe: async () => presented(), confirm: async () => false }))
      .rejects.toMatchObject({ reason: "declined" });
    expect(await knownHosts.get("127.0.0.1:7788")).toBeUndefined();
  });

  it("needs no question for a certificate a trusted authority vouches for", async () => {
    const trust = await establishHostTrust("wss://host.example", {
      knownHosts: known(), probe: async () => presented({ authorized: true }), confirm: neverAsked,
    });
    expect(trust).toEqual({ kind: "authority", hostname: "host.example" });
  });

  it("says so when it cannot even read the certificate", async () => {
    await expect(establishHostTrust("wss://127.0.0.1:1", {
      knownHosts: known(), probe: async () => { throw new Error("ECONNREFUSED"); }, confirm: neverAsked,
    })).rejects.toMatchObject({ reason: "unreachable" });
  });

  it("decides Chromium's verdict for the pinned host only", () => {
    const trust = { kind: "pinned", hostname: "127.0.0.1", fingerprint: FINGERPRINT, source: "known-host" } as const;
    expect(certificateVerdict(trust, "127.0.0.1", FINGERPRINT)).toBe(CERTIFICATE_ACCEPT);
    expect(certificateVerdict(trust, "127.0.0.1", OTHER)).toBe(CERTIFICATE_REJECT);
    expect(certificateVerdict(trust, "example.com", OTHER)).toBe(CERTIFICATE_DEFAULT);
    expect(certificateVerdict({ kind: "authority", hostname: "127.0.0.1" }, "127.0.0.1", OTHER)).toBe(CERTIFICATE_DEFAULT);
    expect(certificateVerdict({ ...trust, hostname: "::1" }, "[::1]", FINGERPRINT)).toBe(CERTIFICATE_ACCEPT);
  });

  it("explains a refusal with both fingerprints and the way to repair it", () => {
    const trust = { kind: "pinned", hostname: "127.0.0.1", fingerprint: FINGERPRINT, source: "known-host" } as const;
    const message = certificateRefusalMessage("wss://127.0.0.1:7788", trust, OTHER, "/data/known-hosts.json");
    expect(message).toContain(`Expected SHA-256: ${FINGERPRINT}`);
    expect(message).toContain(`Presented SHA-256: ${OTHER}`);
    expect(message).toContain("did not send the host token");
    expect(message).toContain("remove the entry for 127.0.0.1:7788 from /data/known-hosts.json");
    expect(certificateRefusalMessage("wss://h:1", { ...trust, source: "environment" }, OTHER, "x")).toContain("update TAU_HOST_FINGERPRINT");
  });

  it("keys a host by name and port", () => {
    expect(hostEndpoint("wss://[::1]:7788/")).toEqual({ hostname: "::1", port: 7788, key: "::1:7788" });
    expect(hostEndpoint("wss://Host.Example")).toEqual({ hostname: "host.example", port: 443, key: "host.example:443" });
  });
});
