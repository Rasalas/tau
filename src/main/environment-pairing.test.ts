import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pairingUrl } from "../shared/connections.js";
import { pairEnvironment } from "./environment-pairing.js";
import { HostAccess } from "./host-access.js";
import { HostPushLog } from "./host-push-log.js";
import { certificateFingerprint } from "./host-tls.js";
import { HostTokenFile } from "./host-token.js";
import { startSocketHostTransport, type SocketHostTransport } from "./host-transport-socket.js";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";

// The window's side of adding a machine, against a real host socket that asks its owner (ADR 0024, 0025).
let transport: SocketHostTransport | undefined;
const directories: string[] = [];

afterEach(async () => {
  await transport?.close();
  transport = undefined;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function machine(endpoints: Array<{ url: string; kind?: "lan" | "mdns" }> = []) {
  const directory = mkdtempSync(join(tmpdir(), "tau-machine-"));
  directories.push(directory);
  let onChange = () => undefined as void;
  const access = await HostAccess.open({
    tokenFile: new HostTokenFile(join(directory, "host-token")),
    storePath: join(directory, "paired-clients.json"),
    onChange: () => onChange(),
  });
  const tls = createSelfSignedCertificate({ commonName: "Tau host", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], days: 30 });
  transport = await startSocketHostTransport({
    listen: "127.0.0.1:0", methods: {}, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [], access, tls,
    host: { id: "host-studio", name: "studio", endpoints: () => endpoints },
  });
  const page = `https://127.0.0.1:${transport.port}/`;
  /** Resolves with the request once the owner could see it. */
  const request = () => new Promise<string>((resolve) => {
    onChange = () => { const waiting = access.overview().requests[0]; if (waiting) resolve(waiting.id); };
  });
  return { access, page, fingerprint: certificateFingerprint(tls.cert), request };
}

describe("adding a machine", () => {
  it("from a pairing link pins its certificate, shows the owner's digits and keeps what the machine says it is", async () => {
    const { access, page, fingerprint, request } = await machine();
    const { code } = access.createLink();
    const link = pairingUrl({ url: page, kind: "loopback" }, { code, fingerprint, hostId: "host-studio", hostName: "Studio (link)" });
    const shown: string[] = [];
    const asked = request();
    const result = pairEnvironment({ text: link, deviceName: "laptop", onWaiting: ({ verification }) => shown.push(verification) });
    const id = await asked;
    expect(access.overview().requests[0]).toMatchObject({ name: "laptop" });
    await expect.poll(() => shown).toEqual([access.overview().requests[0]!.verification]);
    await access.approvePairing(id);
    const added = await result;
    expect(added).toMatchObject({
      state: "approved",
      environment: { id: "host-studio", name: "studio", endpoints: [{ url: page, kind: "loopback" }], lastUrl: page },
    });
    if (added.state !== "approved") return;
    const bare = (value: string | undefined) => value?.replace(/:/gu, "").toLowerCase();
    expect(bare(added.environment.fingerprint)).toBe(bare(fingerprint));
    expect(added.environment.token).toMatch(/\S{16,}/u);
  });

  it("from a bare address reads the certificate first and binds the digits to it", async () => {
    const { access, page, fingerprint, request } = await machine();
    const shown: string[] = [];
    const asked = request();
    const result = pairEnvironment({ text: page.replace("https://", ""), deviceName: "laptop", onWaiting: ({ verification }) => shown.push(verification) });
    await asked;
    await expect.poll(() => shown.length).toBe(1);
    // Bound digits: the window computed its own, and the owner sees the same.
    expect(access.overview().requests[0]!.verification).toBe(shown[0]);
    await access.approvePairing(access.overview().requests[0]!.id);
    const added = await result;
    expect(added).toMatchObject({ state: "approved", environment: { id: "host-studio", endpoints: [{ url: page }] } });
    if (added.state === "approved") expect(added.environment.fingerprint?.replace(/:/gu, "").toLowerCase()).toBe(fingerprint.replace(/:/gu, "").toLowerCase());
  });

  it("found with Bonjour asks without a link, pinned to the record's fingerprint, and keeps the addresses its hello names", async () => {
    const lan = { url: "https://192.168.1.40:47788/", kind: "lan" as const };
    const { access, page, fingerprint, request } = await machine([lan]);
    const shown: string[] = [];
    const asked = request();
    const result = pairEnvironment({
      nearby: { hostId: "host-studio", name: "Studio", fingerprint, endpoints: [{ url: page, kind: "lan" }] },
      deviceName: "laptop",
      onWaiting: ({ verification }) => shown.push(verification),
    });
    await asked;
    await expect.poll(() => shown.length).toBe(1);
    // No link: the owner sees a request without one, and the same digits.
    expect(access.overview().requests[0]).toMatchObject({ verification: shown[0] });
    expect(access.overview().requests[0]!.link).toBeUndefined();
    await access.approvePairing(access.overview().requests[0]!.id);
    const added = await result;
    expect(added).toMatchObject({ state: "approved", environment: { id: "host-studio", lastUrl: page } });
    if (added.state !== "approved") return;
    expect(added.environment.endpoints.map((endpoint) => endpoint.url)).toEqual([lan.url, page]);
    expect(added.environment.fingerprint?.replace(/:/gu, "").toLowerCase()).toBe(fingerprint.replace(/:/gu, "").toLowerCase());
  });

  it("found with Bonjour refuses a machine whose certificate is not the one its record named", async () => {
    const { page } = await machine();
    const other = Array.from({ length: 32 }, () => "CD").join(":");
    const result = await pairEnvironment({ nearby: { hostId: "host-studio", name: "Studio", fingerprint: other, endpoints: [{ url: page, kind: "lan" }] }, deviceName: "laptop" });
    expect(result.state).toBe("failed");
  });

  it("hears the owner's no", async () => {
    const { access, page, request } = await machine();
    const asked = request();
    const denied = pairEnvironment({ text: page, deviceName: "laptop" });
    access.denyPairing(await asked);
    expect(await denied).toEqual({ state: "denied" });
  });

  it("hears a spent link as such", async () => {
    const { page } = await machine();
    const spent = pairingUrl(page, { code: "spent" });
    expect(await pairEnvironment({ text: spent, deviceName: "laptop" })).toMatchObject({ state: "failed", message: expect.stringMatching(/used already, expired/u) });
  });

  it("says what it needs when given nothing it can read", async () => {
    expect(await pairEnvironment({ text: "hello there", deviceName: "laptop" })).toMatchObject({ state: "failed", message: expect.stringMatching(/pairing link or type an address/u) });
  });
});
