import { describe, expect, it } from "vitest";
import { DEFAULT_NETWORK_SETTINGS } from "../shared/connections.js";
import { NetworkContributions, acceptedEndpoint } from "./host-network-contributions.js";

function bound() {
  const contributions = new NetworkContributions();
  const calls: string[] = [];
  contributions.bind({
    state: () => ({ settings: DEFAULT_NETWORK_SETTINGS, listeners: [], problems: [], tailscaleUp: false, ...(contributions.proxyHeld ? { proxyHeld: true } : {}) }),
    reconcile: async () => { calls.push(`reconcile:${contributions.proxyHeld}`); },
    endpointsChanged: async () => { calls.push(`endpoints:${contributions.endpoints().length}`); },
  });
  return { contributions, calls, network: contributions.services };
}

describe("a package's part of network access", () => {
  it("holds the proxy listener until the last hold is released", async () => {
    const { contributions, calls, network } = bound();
    const first = await network.holdProxy();
    const second = await network.holdProxy();
    expect(contributions.proxyHeld).toBe(true);
    expect(network.state()?.proxyHeld).toBe(true);
    first();
    first();
    expect(contributions.proxyHeld).toBe(true);
    second();
    expect(contributions.proxyHeld).toBe(false);
    expect(calls).toEqual(["reconcile:true", "reconcile:false"]);
  });

  it("publishes endpoints until withdrawn, and takes only what a device could open", () => {
    const { contributions, calls, network } = bound();
    const withdraw = network.publishEndpoints([
      { url: "https://box.tail0000.ts.net/", label: "Tailscale HTTPS", reachability: "network", kind: "magicdns", trustedCertificate: true },
      { url: "file:///etc/passwd", label: "Nope", reachability: "network" },
      { url: "https://user:secret@box.example/", label: "Credentials", reachability: "network" },
    ]);
    expect(contributions.endpoints()).toEqual([{ url: "https://box.tail0000.ts.net/", label: "Tailscale HTTPS", reachability: "network", kind: "magicdns", trustedCertificate: true }]);
    withdraw();
    withdraw();
    expect(contributions.endpoints()).toEqual([]);
    expect(calls).toEqual(["endpoints:1", "endpoints:0"]);
  });

  it("keeps what was asked before the listeners exist, and answers no state meanwhile", async () => {
    const contributions = new NetworkContributions();
    await contributions.services.holdProxy();
    contributions.services.publishEndpoints([{ url: "https://a.example/", label: "A", reachability: "network" }]);
    expect(contributions.services.state()).toBeUndefined();
    expect(contributions.proxyHeld).toBe(true);
    expect(contributions.endpoints()).toHaveLength(1);
  });

  it("marks a trusted certificate only on https and forces network reachability", () => {
    expect(acceptedEndpoint({ url: "http://a.example:80/x", label: " A ", reachability: "loopback", trustedCertificate: true, kind: "loopback" }))
      .toEqual({ url: "http://a.example/x", label: "A", reachability: "network" });
    expect(acceptedEndpoint({ url: "https://a.example/#pair=1", label: "A" })).toBeUndefined();
    expect(acceptedEndpoint({ url: "https://a.example/", label: "" })).toBeUndefined();
  });
});
