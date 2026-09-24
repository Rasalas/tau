import { createPrivateKey, X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";
import { certificateFingerprint, publicKeyPin } from "./host-tls.js";
import { HostCertificateRefusedError, authorityTlsConnect, pinAccepts, pinnedTlsConnect, type PresentedIdentity } from "./host-tls-trust.js";
import { createTestAuthority } from "./test-support/test-authority.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

// Loopback only; the server answers the handshake and nothing else.
async function serve(material: { cert: string; key: string }): Promise<number> {
  const server = createServer({ cert: material.cert, key: material.key, minVersion: "TLSv1.2" }, (socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

type Connect = (options: { host: string; port: number; servername?: string }) => TLSSocket;

function handshake(connect: Connect, port: number, servername?: string): Promise<"accepted" | Error> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, ...(servername ? { servername } : {}) });
    // A pinned socket decides in its own secureConnect listener, which runs first.
    socket.once("secureConnect", () => setImmediate(() => { if (!socket.destroyed) { socket.destroy(); resolve("accepted"); } }));
    socket.once("error", (error) => resolve(error));
  });
}

const base = { commonName: "Tau host", dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"], days: 30 };

describe("key pins", () => {
  it("accept a renewed certificate with the same key", async () => {
    const first = createSelfSignedCertificate(base);
    const renewed = createSelfSignedCertificate({ ...base, privateKey: createPrivateKey(first.key), now: new Date(Date.now() + 86_400_000) });
    expect(certificateFingerprint(renewed.cert)).not.toBe(certificateFingerprint(first.cert));
    const port = await serve(renewed);
    const seen: PresentedIdentity[] = [];
    expect(await handshake(pinnedTlsConnect({ publicKey: publicKeyPin(first.cert) }, (presented) => seen.push(presented)) as Connect, port)).toBe("accepted");
    expect(seen).toEqual([{ fingerprint: certificateFingerprint(renewed.cert), publicKey: publicKeyPin(first.cert) }]);
  });

  it("refuse a certificate with a new key, even one for the same names", async () => {
    const pinned = createSelfSignedCertificate(base);
    const port = await serve(createSelfSignedCertificate(base));
    const result = await handshake(pinnedTlsConnect({ publicKey: publicKeyPin(pinned.cert) }) as Connect, port);
    expect(result).toBeInstanceOf(HostCertificateRefusedError);
    expect((result as HostCertificateRefusedError).kind).toBe("key");
  });

  it("decide on the key when there is one, and never fall back to the certificate", () => {
    const presented = { fingerprint: "AA", publicKey: "BB" };
    const key = publicKeyPin(createSelfSignedCertificate(base).cert);
    expect(pinAccepts({ publicKey: key, fingerprint: "AA" }, { ...presented, publicKey: key })).toBe(true);
    expect(pinAccepts({ publicKey: key, fingerprint: presented.fingerprint }, presented)).toBe(false);
    expect(pinAccepts({}, presented)).toBe(false);
  });

  it("still take an old certificate pin, which a renewal breaks", async () => {
    const first = createSelfSignedCertificate(base);
    const renewed = createSelfSignedCertificate({ ...base, privateKey: createPrivateKey(first.key) });
    expect(await handshake(pinnedTlsConnect(certificateFingerprint(first.cert)) as Connect, await serve(first))).toBe("accepted");
    expect(await handshake(pinnedTlsConnect(certificateFingerprint(first.cert)) as Connect, await serve(renewed))).toBeInstanceOf(HostCertificateRefusedError);
  });
});

describe("an address a certificate authority vouches for", () => {
  it("is accepted with a chain to a trusted authority and a matching name, without a pin", async () => {
    const authority = createTestAuthority();
    const leaf = authority.issue({ dnsNames: ["box.tailnet.test"] });
    expect(new X509Certificate(leaf.cert).verify(new X509Certificate(authority.cert).publicKey)).toBe(true);
    const port = await serve(leaf);
    expect(await handshake(authorityTlsConnect(authority.cert) as Connect, port, "box.tailnet.test")).toBe("accepted");
  });

  it("is refused with a chain to an authority the client does not trust", async () => {
    const trusted = createTestAuthority();
    const port = await serve(createTestAuthority("Impostor CA").issue({ dnsNames: ["box.tailnet.test"] }));
    const result = await handshake(authorityTlsConnect(trusted.cert) as Connect, port, "box.tailnet.test");
    expect(result).toBeInstanceOf(Error);
  });

  it("is refused with a self-signed certificate, which only a pin could accept", async () => {
    const port = await serve(createSelfSignedCertificate({ ...base, dnsNames: ["box.tailnet.test"] }));
    expect(await handshake(authorityTlsConnect(createTestAuthority().cert) as Connect, port, "box.tailnet.test")).toBeInstanceOf(Error);
  });

  it("is refused for a name the certificate does not carry", async () => {
    const authority = createTestAuthority();
    const port = await serve(authority.issue({ dnsNames: ["other.tailnet.test"] }));
    expect(await handshake(authorityTlsConnect(authority.cert) as Connect, port, "box.tailnet.test")).toBeInstanceOf(Error);
  });
});
