import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type ClientOptions } from "ws";
import { pairWithHost, type PairingSocket } from "../workbench/host-pairing.js";
import { HostAccess } from "./host-access.js";
import { HostPushLog } from "./host-push-log.js";
import { HostTokenFile } from "./host-token.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";
import { certificateFingerprint, publicKeyPin } from "./host-tls.js";
import { pinnedTlsConnect } from "./host-tls-trust.js";

// The device's half of pairing against the host's real socket: what the browser client and the app run.
let transport: SocketHostTransport | undefined;
const directories: string[] = [];

const accesses: HostAccess[] = [];

afterEach(async () => {
  await transport?.close();
  transport = undefined;
  // Closing the transport detaches its devices, which writes the store in the background.
  await Promise.all(accesses.splice(0).map((access) => access.flush().catch(() => undefined)));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function host(tls?: { cert: string; key: string }) {
  const directory = mkdtempSync(join(tmpdir(), "tau-pairing-"));
  directories.push(directory);
  let onChange = () => undefined as void;
  const access = await HostAccess.open({
    tokenFile: new HostTokenFile(join(directory, "host-token")),
    storePath: join(directory, "paired-clients.json"),
    onChange: () => onChange(),
  });
  accesses.push(access);
  transport = await startSocketHostTransport({ listen: "127.0.0.1:0", methods: {}, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [], access, ...(tls ? { tls } : {}) });
  /** Resolves with the request once the owner could see it. */
  const request = () => new Promise<string>((resolve) => {
    onChange = () => { const waiting = access.overview().requests[0]; if (waiting) resolve(waiting.id); };
  });
  return { access, url: `${tls ? "wss" : "ws"}://127.0.0.1:${transport.port}`, request };
}

const socket = (url: string) => new WebSocket(url) as unknown as PairingSocket;

describe("a device pairing with a host", () => {
  it("shows the host's digits and gets its token once the owner allows it", async () => {
    const { access, url, request } = await host();
    const { code } = access.createLink({ access: "read-only" });
    const shown: string[] = [];
    const asked = request();
    const result = pairWithHost({ url, code, name: "Phone", createSocket: socket, onWaiting: ({ verification }) => shown.push(verification) });
    const id = await asked;
    const { verification } = access.overview().requests[0]!;
    expect(access.overview().requests[0]).toMatchObject({ name: "Phone" });
    await expect.poll(() => shown).toEqual([verification]);
    await access.approvePairing(id);
    expect(await result).toMatchObject({ state: "approved", access: "read-only" });
  });

  it("computes its own digits when it pinned the certificate, and the owner sees the same", async () => {
    const { access, url, request } = await host();
    const shown: string[] = [];
    const asked = request();
    // A plaintext loopback socket presents no certificate; its fingerprint is empty on both sides.
    const result = pairWithHost({ url, fingerprint: "", createSocket: socket, onWaiting: ({ verification }) => shown.push(verification) });
    await asked;
    await expect.poll(() => shown.length).toBe(1);
    expect(access.overview().requests[0]!.verification).toBe(shown[0]);
    access.denyPairing(access.overview().requests[0]!.id);
    expect(await result).toEqual({ state: "denied" });
  });

  it("binds the digits to the certificate of the TLS listener the device pinned", async () => {
    const tls = createSelfSignedCertificate({ commonName: "Tau host", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], days: 30 });
    const fingerprint = certificateFingerprint(tls.cert);
    const { access, url, request } = await host(tls);
    const shown: string[] = [];
    const asked = request();
    const result = pairWithHost({
      url,
      fingerprint,
      createSocket: (target) => new WebSocket(target, { createConnection: pinnedTlsConnect(fingerprint) as unknown as ClientOptions["createConnection"] }) as unknown as PairingSocket,
      onWaiting: ({ verification }) => shown.push(verification),
    });
    const id = await asked;
    await expect.poll(() => shown.length).toBe(1);
    expect(access.overview().requests[0]!.verification).toBe(shown[0]);
    await access.approvePairing(id);
    expect(await result).toMatchObject({ state: "approved" });
  });

  it("binds the digits to the listener's key when the device pinned the key", async () => {
    const tls = createSelfSignedCertificate({ commonName: "Tau host", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], days: 30 });
    const publicKey = publicKeyPin(tls.cert);
    const { access, url, request } = await host(tls);
    const shown: string[] = [];
    const asked = request();
    const result = pairWithHost({
      url,
      publicKey,
      createSocket: (target) => new WebSocket(target, { createConnection: pinnedTlsConnect({ publicKey }) as unknown as ClientOptions["createConnection"] }) as unknown as PairingSocket,
      onWaiting: ({ verification }) => shown.push(verification),
    });
    await asked;
    await expect.poll(() => shown.length).toBe(1);
    expect(access.overview().requests[0]!.verification).toBe(shown[0]);
    access.denyPairing(access.overview().requests[0]!.id);
    expect(await result).toEqual({ state: "denied" });
  });

  it("gives up when its key-bound digits differ: the listener's key is not the one it saw", async () => {
    const tls = createSelfSignedCertificate({ commonName: "Tau host", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], days: 30 });
    const { url } = await host(tls);
    // What a relay with a key of its own would make the device compute.
    const relayKey = publicKeyPin(createSelfSignedCertificate({ commonName: "Relay", dnsNames: [], ipAddresses: [], days: 1 }).cert);
    const result = await pairWithHost({
      url,
      publicKey: relayKey,
      createSocket: (target) => new WebSocket(target, { createConnection: pinnedTlsConnect(certificateFingerprint(tls.cert)) as unknown as ClientOptions["createConnection"] }) as unknown as PairingSocket,
    });
    expect(result).toMatchObject({ state: "failed", message: expect.stringMatching(/not the host/u) });
  });

  it("gives up when the host's digits are not its own: something in between is not the host", async () => {
    const { url } = await host();
    const result = await pairWithHost({ url, fingerprint: "AB:".repeat(31) + "AB", createSocket: socket });
    expect(result).toMatchObject({ state: "failed", message: expect.stringMatching(/not the host/u) });
  });

  it("hears a spent link as such", async () => {
    const { url } = await host();
    expect(await pairWithHost({ url, code: "spent", createSocket: socket })).toEqual({ state: "refused", reason: "unknown-code" });
  });
});
