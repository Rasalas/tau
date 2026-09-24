import { describe, expect, it } from "vitest";
import { discoveredHost, discoveredHosts, withDiscoveredEndpoint } from "./discovery";
import type { SavedHost } from "./hosts";

const FP_HEX = "ab".repeat(32);
const FP = "AB:".repeat(31) + "AB";

describe("Bonjour records", () => {
  it("reads the host id, the fingerprint and the address a record resolved to", () => {
    expect(discoveredHost({ name: "Tau on Mac mini", host: "192.168.1.47", port: 7788, txt: { host: "h-1", fp: FP_HEX } })).toEqual({
      hostId: "h-1",
      name: "Tau on Mac mini",
      fingerprint: FP,
      endpoint: { url: "https://192.168.1.47:7788/", kind: "lan" },
    });
    expect(discoveredHost({ name: "x", host: "Mac-mini.local.", port: 7788, txt: { id: "h-2", fingerprint: FP, name: "Studio" } })).toMatchObject({
      name: "Studio",
      endpoint: { url: "https://Mac-mini.local:7788/", kind: "mdns" },
    });
    expect(discoveredHost({ name: "x", host: "fe80::1", port: 7788, txt: { host: "h", fp: FP_HEX } })?.endpoint.url).toBe("https://[fe80::1]:7788/");
    expect(discoveredHost({ name: "x", host: "127.0.0.1%lo0", port: 7788, txt: { host: "h", fp: FP_HEX } })?.endpoint.url).toBe("https://127.0.0.1:7788/");
    expect(discoveredHost({ name: "x", host: "[fe80::1%en0]", port: 7788, txt: { host: "h", fp: FP_HEX } })?.endpoint.url).toBe("https://[fe80::1]:7788/");
  });

  it("skips a record the app could not pin or place", () => {
    expect(discoveredHost({ name: "x", host: "10.0.0.2", port: 7788, txt: { host: "h" } })).toBeUndefined();
    expect(discoveredHost({ name: "x", host: "10.0.0.2", port: 7788, txt: { fp: FP_HEX } })).toBeUndefined();
    expect(discoveredHost({ name: "x", host: "10.0.0.2", port: 0, txt: { host: "h", fp: FP_HEX } })).toBeUndefined();
    expect(discoveredHost({ name: "x", host: "10.0.0.2", port: 7788, txt: { host: "h", fp: "short" } })).toBeUndefined();
  });

  it("lists a host seen on two interfaces once", () => {
    const record = { name: "x", port: 7788, txt: { host: "h", fp: FP_HEX } };
    expect(discoveredHosts([{ ...record, host: "192.168.1.2" }, { ...record, host: "192.168.1.3" }])).toHaveLength(1);
  });

  it("moves a saved host's new address first only when the record has the pinned certificate", () => {
    const saved: SavedHost = { id: "h", name: "Mac", fingerprint: FP, endpoints: [{ url: "https://192.168.1.2:7788/", kind: "lan" }], access: "full", addedAt: "" };
    const moved = { hostId: "h", name: "Mac", fingerprint: FP, endpoint: { url: "https://192.168.1.9:7788/", kind: "lan" as const } };
    expect(withDiscoveredEndpoint(saved, moved)?.map((entry) => entry.url)).toEqual(["https://192.168.1.9:7788/", "https://192.168.1.2:7788/"]);
    expect(withDiscoveredEndpoint(saved, { ...moved, fingerprint: "CD:".repeat(31) + "CD" })).toBeUndefined();
    expect(withDiscoveredEndpoint(saved, { ...moved, endpoint: saved.endpoints[0]! })).toBeUndefined();
  });
});
