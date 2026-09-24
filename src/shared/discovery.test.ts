import { describe, expect, it } from "vitest";
import { discoveredEndpoints, discoveredHosts, isServiceType, readTauServiceTxt, tauServiceTxt, type ResolvedService } from "./discovery.js";

const FP = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
const HOST_ID = "0123456789abcdef0123456789abcdef";

function service(overrides: Partial<ResolvedService> = {}): ResolvedService {
  return { name: "Studio", hostName: "studio.local", port: 7788, txt: tauServiceTxt({ hostId: HOST_ID, fingerprint: FP }), addresses: ["192.168.1.20"], ...overrides };
}

describe("the Bonjour TXT record", () => {
  it("carries the version, the host id and the fingerprint without colons, nothing else", () => {
    expect(tauServiceTxt({ hostId: HOST_ID, fingerprint: FP })).toEqual({ v: "1", id: HOST_ID, fp: FP.replace(/:/gu, "") });
  });

  it("adds the key pin, which a reader of before ignores", () => {
    const publicKey = "CD:".repeat(31) + "CD";
    const txt = tauServiceTxt({ hostId: HOST_ID, fingerprint: FP, publicKey });
    expect(txt.pk).toBe("CD".repeat(32));
    expect(readTauServiceTxt(txt)).toEqual({ hostId: HOST_ID, fingerprint: FP, publicKey });
    expect(readTauServiceTxt({ ...txt, pk: "zz" })).toEqual({ hostId: HOST_ID, fingerprint: FP });
  });

  it("reads back to the same host and a pinnable fingerprint", () => {
    expect(readTauServiceTxt(tauServiceTxt({ hostId: HOST_ID, fingerprint: FP }))).toEqual({ hostId: HOST_ID, fingerprint: FP });
  });

  it("is ignored in another version, without an id, or with a fingerprint that is not SHA-256", () => {
    expect(readTauServiceTxt({ v: "2", id: HOST_ID, fp: FP })).toBeUndefined();
    expect(readTauServiceTxt({ v: "1", fp: FP })).toBeUndefined();
    expect(readTauServiceTxt({ v: "1", id: HOST_ID, fp: "abcd" })).toBeUndefined();
    expect(readTauServiceTxt({ v: "1", id: "id with spaces", fp: FP })).toBeUndefined();
  });

  it("refuses to announce without a certificate to pin", () => {
    expect(() => tauServiceTxt({ hostId: HOST_ID, fingerprint: "" })).toThrow(/fingerprint/u);
  });
});

describe("service types", () => {
  it("are _name._tcp and nothing a command line could misread", () => {
    expect(isServiceType("_tau._tcp")).toBe(true);
    expect(isServiceType("_tau-test._tcp")).toBe(true);
    expect(isServiceType("_tau._udp")).toBe(false);
    expect(isServiceType("tau._tcp")).toBe(false);
    expect(isServiceType("_tau._tcp; rm -rf /")).toBe(false);
    expect(isServiceType("_a-very-long-service-name._tcp")).toBe(false);
  });
});

describe("a discovered host", () => {
  it("offers IPv4, then IPv6, then its .local name, never loopback or link-local", () => {
    expect(discoveredEndpoints({ hostName: "Studio.local.", port: 7788, addresses: ["::1", "fe80::1", "127.0.0.1", "169.254.3.4", "2001:db8::5", "192.168.1.20"] })).toEqual([
      { url: "https://192.168.1.20:7788/", kind: "lan" },
      { url: "https://[2001:db8::5]:7788/", kind: "lan" },
      { url: "https://studio.local:7788/", kind: "mdns" },
    ]);
  });

  it("is one entry per host, its addresses merged across interfaces and families", () => {
    const hosts = discoveredHosts([service(), service({ addresses: ["2001:db8::5"] }), service({ addresses: ["192.168.1.20"] })]);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ name: "Studio", hostId: HOST_ID, fingerprint: FP, port: 7788, hostName: "studio.local", addresses: ["192.168.1.20", "2001:db8::5"] });
  });

  it("leaves out records that are not Tau's and marks this machine's own, listed last", () => {
    const other = "fedcba9876543210fedcba9876543210";
    const hosts = discoveredHosts([
      service({ name: "Printer", txt: { rp: "ipp/print" } }),
      service({ name: "This Mac" }),
      service({ name: "Laptop", txt: tauServiceTxt({ hostId: other, fingerprint: FP }), addresses: ["192.168.1.30"] }),
      service({ name: "Broken", port: 0, txt: tauServiceTxt({ hostId: other, fingerprint: FP }) }),
    ], HOST_ID);
    expect(hosts.map((host) => [host.name, host.self ?? false])).toEqual([["Laptop", false], ["This Mac", true]]);
  });
});
