import { X509Certificate, createPrivateKey } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSelfSignedCertificate } from "./self-signed-certificate.js";
import { certificateFingerprint, fingerprintsMatch, normalizeFingerprint, resolveHostTls } from "./host-tls.js";

const directories: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "tau-tls-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("self-signed certificate", () => {
  it("is a v3 server certificate signed by its own key, naming the given hosts", () => {
    const { cert, key } = createSelfSignedCertificate({
      commonName: "Tau host",
      dnsNames: ["localhost", "box.tailnet.ts.net"],
      ipAddresses: ["127.0.0.1", "::1", "100.64.0.7"],
      days: 825,
    });
    const parsed = new X509Certificate(cert);
    expect(parsed.subject).toBe("CN=Tau host");
    expect(parsed.issuer).toBe("CN=Tau host");
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(parsed.checkPrivateKey(createPrivateKey(key))).toBe(true);
    expect(parsed.ca).toBe(false);
    expect(parsed.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(parsed.checkHost("box.tailnet.ts.net")).toBe("box.tailnet.ts.net");
    expect(parsed.checkIP("100.64.0.7")).toBe("100.64.0.7");
    expect(parsed.checkIP("::1")).toBe("::1");
    expect(parsed.checkHost("example.com")).toBeUndefined();
    const days = (Date.parse(parsed.validTo) - Date.parse(parsed.validFrom)) / 86_400_000;
    expect(Math.round(days)).toBe(825);
  });

  it("writes dates past 2049 as GeneralizedTime", () => {
    const { cert } = createSelfSignedCertificate({
      commonName: "Tau host", dnsNames: [], ipAddresses: [], days: 825, now: new Date("2049-06-01T00:00:00Z"),
    });
    expect(new Date(new X509Certificate(cert).validTo).getUTCFullYear()).toBe(2051);
  });

  it("makes a new key every time", () => {
    const options = { commonName: "Tau host", dnsNames: [], ipAddresses: [], days: 1 };
    expect(certificateFingerprint(createSelfSignedCertificate(options).cert))
      .not.toBe(certificateFingerprint(createSelfSignedCertificate(options).cert));
  });
});

describe("host TLS material", () => {
  it("is off unless asked for", () => {
    expect(resolveHostTls({}, { userData: scratch() })).toBeUndefined();
    expect(resolveHostTls({ TAU_HOST_TLS: "0" }, { userData: scratch() })).toBeUndefined();
  });

  it("creates a self-signed certificate once, 0o600 in a 0o700 directory, and keeps its fingerprint", () => {
    const userData = scratch();
    const first = resolveHostTls({ TAU_HOST_TLS: "1" }, { userData, bindHost: "100.64.0.7" })!;
    expect(first).toMatchObject({ source: "self-signed", created: true, certPath: join(userData, "tls", "host-cert.pem") });
    expect(statSync(first.keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(first.certPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(userData, "tls")).mode & 0o777).toBe(0o700);
    expect(new X509Certificate(first.cert).checkIP("100.64.0.7")).toBe("100.64.0.7");

    const second = resolveHostTls({ TAU_HOST_TLS: "1" }, { userData })!;
    expect(second.created).toBe(false);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("tightens a key file that was restored with looser permissions", () => {
    const userData = scratch();
    const first = resolveHostTls({ TAU_HOST_TLS: "1" }, { userData })!;
    chmodSync(first.keyPath, 0o644);
    resolveHostTls({ TAU_HOST_TLS: "1" }, { userData });
    expect(statSync(first.keyPath).mode & 0o777).toBe(0o600);
  });

  it("renews a self-signed certificate before it runs out", () => {
    const userData = scratch();
    const first = resolveHostTls({ TAU_HOST_TLS: "1" }, { userData })!;
    const later = new Date(Date.now() + 820 * 86_400_000);
    const renewed = resolveHostTls({ TAU_HOST_TLS: "1" }, { userData, now: later })!;
    expect(renewed.created).toBe(true);
    expect(renewed.fingerprint).not.toBe(first.fingerprint);
  });

  it("replaces a damaged pair instead of failing to start", () => {
    const userData = scratch();
    const first = resolveHostTls({ TAU_HOST_TLS: "1" }, { userData })!;
    writeFileSync(first.keyPath, "not a key");
    const replaced = resolveHostTls({ TAU_HOST_TLS: "1" }, { userData })!;
    expect(replaced.created).toBe(true);
    expect(new X509Certificate(replaced.cert).checkPrivateKey(createPrivateKey(readFileSync(replaced.keyPath, "utf8")))).toBe(true);
  });

  it("uses a supplied certificate and key, and warns about a key others can read", () => {
    const directory = scratch();
    const { cert, key } = createSelfSignedCertificate({ commonName: "mine", dnsNames: ["host.example"], ipAddresses: [], days: 90 });
    const certPath = join(directory, "cert.pem");
    const keyPath = join(directory, "key.pem");
    writeFileSync(certPath, cert);
    writeFileSync(keyPath, key, { mode: 0o644 });
    chmodSync(keyPath, 0o644);
    const supplied = resolveHostTls({ TAU_HOST_TLS_CERT: certPath, TAU_HOST_TLS_KEY: keyPath }, { userData: directory })!;
    expect(supplied).toMatchObject({ source: "supplied", created: false, fingerprint: certificateFingerprint(cert) });
    expect(supplied.warnings.join("\n")).toMatch(/readable by other users/u);
  });

  it("refuses half a pair or a key that belongs to another certificate", () => {
    const directory = scratch();
    const one = createSelfSignedCertificate({ commonName: "one", dnsNames: [], ipAddresses: [], days: 1 });
    const two = createSelfSignedCertificate({ commonName: "two", dnsNames: [], ipAddresses: [], days: 1 });
    writeFileSync(join(directory, "cert.pem"), one.cert);
    writeFileSync(join(directory, "key.pem"), two.key, { mode: 0o600 });
    expect(() => resolveHostTls({ TAU_HOST_TLS_CERT: join(directory, "cert.pem") }, { userData: directory })).toThrow(/set both/u);
    expect(() => resolveHostTls(
      { TAU_HOST_TLS_CERT: join(directory, "cert.pem"), TAU_HOST_TLS_KEY: join(directory, "key.pem") },
      { userData: directory },
    )).toThrow(/is not the key/u);
  });
});

describe("fingerprints", () => {
  const canonical = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0").toUpperCase()).join(":");

  it("accepts the ways a person writes one", () => {
    const hex = canonical.replace(/:/gu, "");
    for (const written of [canonical, canonical.toLowerCase(), hex, `sha256:${hex}`, `SHA256 ${canonical}`, `sha256/${canonical}`, `SHA-256=${hex}`]) {
      expect(normalizeFingerprint(written)).toBe(canonical);
    }
  });

  it("rejects anything that is not 32 bytes of hex", () => {
    for (const written of ["", "AB:CD", `${canonical}:00`, canonical.replace("0F", "0G")]) {
      expect(normalizeFingerprint(written)).toBeUndefined();
    }
    expect(fingerprintsMatch("nonsense", "nonsense")).toBe(false);
    expect(fingerprintsMatch(canonical, canonical.toLowerCase().replace(/:/gu, ""))).toBe(true);
  });
});
