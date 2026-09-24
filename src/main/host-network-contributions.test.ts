import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_NETWORK_SETTINGS } from "../shared/connections.js";
import { extensionServices, type HostExtensionServices } from "./host-extensions.js";
import { NetworkContributions, acceptedEndpoint } from "./host-network-contributions.js";

function bound(storePath?: string) {
  const contributions = new NetworkContributions(storePath ? { storePath } : {});
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

describe("a package that keeps the proxy listener", () => {
  it("keeps it across a restart, before any package runs, until it lets go", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-network-kept-"));
    try {
      const storePath = join(directory, "network-kept.json");
      const first = bound(storePath);
      await first.contributions.forExtension("tau.tailscale").keepProxy(true);
      expect(first.contributions.proxyHeld).toBe(true);
      expect(JSON.parse(readFileSync(storePath, "utf8"))).toMatchObject({ kept: ["tau.tailscale"] });

      const second = bound(storePath);
      await second.contributions.load();
      expect(second.contributions.proxyHeld).toBe(true);
      await second.contributions.forExtension("acme.other").keepProxy(false);
      expect(second.contributions.proxyHeld).toBe(true);
      await second.contributions.forExtension("tau.tailscale").keepProxy(false);
      expect(second.contributions.proxyHeld).toBe(false);
      expect(second.calls).toEqual(["reconcile:false"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("speaks only for the package whose services it came through", async () => {
    const { contributions } = bound();
    await expect(contributions.services.keepProxy(true)).rejects.toThrow(/one package/u);
    const services = extensionServices({ network: contributions.services, log: () => undefined } as unknown as HostExtensionServices, { id: "tau.tailscale", permissions: ["network"] });
    await services.network!.keepProxy(true);
    expect(contributions.proxyHeld).toBe(true);
    const denied = extensionServices({ network: contributions.services, log: () => undefined } as unknown as HostExtensionServices, { id: "acme.nosy", permissions: [] });
    expect(() => denied.network).toThrow(/lacks permission network/u);
  });
});
