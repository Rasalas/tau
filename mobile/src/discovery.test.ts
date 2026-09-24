import { describe, expect, it } from "vitest";
import { nearbyHosts, resolvedService, withDiscoveredEndpoints, type DiscoveredHost } from "./discovery";
import type { SavedHost } from "./hosts";

const FP_HEX = "ab".repeat(32);
const FP = "AB:".repeat(31) + "AB";
const TXT = { v: "1", id: "host-0001", fp: FP_HEX };

describe("Bonjour records", () => {
  it("reads F06's record and the address the native side resolved it to", () => {
    const [host] = nearbyHosts([{ name: "Mac mini von Alex", host: "192.168.1.47", port: 7788, txt: TXT }], false);
    expect(host).toMatchObject({ hostId: "host-0001", name: "Mac mini von Alex", fingerprint: FP, endpoints: [{ url: "https://192.168.1.47:7788/", kind: "lan" }] });
  });

  it("merges a host seen on two addresses, and keeps an address without its zone", () => {
    const hosts = nearbyHosts([
      { name: "Mac", host: "192.168.1.2", port: 7788, txt: TXT },
      { name: "Mac", host: "[fd00::5%en0]", port: 7788, txt: TXT },
      { name: "Mac", host: "Mac-mini.local.", port: 7788, txt: TXT },
    ], false);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]!.endpoints.map((endpoint) => endpoint.url)).toEqual(["https://192.168.1.2:7788/", "https://[fd00::5]:7788/", "https://mac-mini.local:7788/"]);
  });

  it("skips what is not a version-1 Tau record, and what a phone cannot reach", () => {
    expect(nearbyHosts([{ name: "x", host: "10.0.0.2", port: 7788, txt: { id: "host-0001", fp: FP_HEX } }], false)).toEqual([]);
    expect(nearbyHosts([{ name: "x", host: "10.0.0.2", port: 7788, txt: { v: "1", id: "host-0001" } }], false)).toEqual([]);
    expect(nearbyHosts([{ name: "x", host: "127.0.0.1", port: 7788, txt: TXT }], false)).toEqual([]);
  });

  it("reaches a host on the development machine's loopback from a simulator only", () => {
    const [host] = nearbyHosts([{ name: "Test", host: "127.0.0.1%lo0", port: 60664, txt: TXT }], true);
    expect(host?.endpoints).toEqual([{ url: "https://127.0.0.1:60664/", kind: "loopback" }]);
  });

  it("reads a name as a name and an address as an address", () => {
    expect(resolvedService({ name: "x", host: "Mac.local.", port: 1, txt: {} })).toMatchObject({ addresses: [], hostName: "Mac.local" });
    expect(resolvedService({ name: "x", host: "[fe80::1%en0]", port: 1, txt: {} }).addresses).toEqual(["fe80::1"]);
  });
});

describe("withDiscoveredEndpoints", () => {
  const saved: SavedHost = { id: "host-0001", name: "Mac", fingerprint: FP, endpoints: [{ url: "https://192.168.1.2:7788/", kind: "lan" }, { url: "https://100.64.0.2:7788/", kind: "tailscale" }], access: "full", addedAt: "" };
  const found = (url: string, fingerprint = FP): DiscoveredHost => ({ name: "Mac", hostId: "host-0001", fingerprint, port: 7788, addresses: [], endpoints: [{ url, kind: "lan" }] });

  it("puts a saved host's new address first when the record has the pinned certificate", () => {
    expect(withDiscoveredEndpoints(saved, found("https://192.168.1.9:7788/"))?.map((entry) => entry.url)).toEqual(["https://192.168.1.9:7788/", "https://192.168.1.2:7788/", "https://100.64.0.2:7788/"]);
  });

  it("changes nothing for another certificate or an address it already leads with", () => {
    expect(withDiscoveredEndpoints(saved, found("https://192.168.1.9:7788/", "CD:".repeat(31) + "CD"))).toBeUndefined();
    expect(withDiscoveredEndpoints(saved, found("https://192.168.1.2:7788/"))).toBeUndefined();
  });

  it("compares keys once the host is pinned by key: a renewed certificate still matches, another key does not", () => {
    const KEY = "EF:".repeat(31) + "EF";
    const keyed: SavedHost = { ...saved, fingerprint: undefined, publicKey: KEY } as SavedHost;
    const renewed = { ...found("https://192.168.1.9:7788/", "CD:".repeat(31) + "CD"), publicKey: KEY };
    expect(withDiscoveredEndpoints(keyed, renewed)?.[0]?.url).toBe("https://192.168.1.9:7788/");
    expect(withDiscoveredEndpoints(keyed, { ...renewed, publicKey: FP })).toBeUndefined();
    // A record from before key pins proves nothing about the key.
    expect(withDiscoveredEndpoints(keyed, found("https://192.168.1.9:7788/"))).toBeUndefined();
  });
});
