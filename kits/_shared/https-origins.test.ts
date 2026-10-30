import { expect, it } from "vitest";
import type { HostNetworkServices } from "tau/host-extension";
import { httpsOrigins } from "./https-origins.js";

function network() {
  const state = {
    settings: { lan: false, tailscale: true, announce: false, port: 7790, proxyPort: 7791, certificate: { certPath: "/private/leaf.pem", keyPath: "/private/key.pem" } },
    listeners: [{ host: "100.70.80.90", port: 7790, kind: "network" as const }, { host: "fd7a:115c:a1e0::1", port: 7790, kind: "network" as const }],
    problems: [], tailscaleUp: true,
    certificate: { source: "supplied" as "supplied" | "self-signed", fingerprint: "fixture", validTo: new Date(Date.now() + 86_400_000).toISOString(), certPath: "/private/leaf.pem", warnings: [] as string[] },
  };
  const services: HostNetworkServices = { state: () => state, holdProxy: async () => () => undefined, keepProxy: async () => undefined, publishEndpoints: () => () => undefined };
  return { state, services };
}
it("offers private-certificate HTTPS only on explicit Tailnet-only TLS listeners", () => {
  const { services } = network();
  expect(httpsOrigins(services)).toEqual(["https://100.70.80.90:7790", "https://[fd7a:115c:a1e0::1]:7790"]);
  expect(httpsOrigins(undefined)).toEqual([]);
});
it("refuses automatic self-signed certificates, stale configuration, LAN and expired material", () => {
  for (const change of [
    (s: ReturnType<typeof network>["state"]) => { s.certificate.source = "self-signed"; },
    (s: ReturnType<typeof network>["state"]) => { s.settings.lan = true; },
    (s: ReturnType<typeof network>["state"]) => { s.settings.tailscale = false; },
    (s: ReturnType<typeof network>["state"]) => { s.certificate.certPath = "/stale.pem"; },
    (s: ReturnType<typeof network>["state"]) => { s.certificate.validTo = "2000-01-01T00:00:00Z"; },
    (s: ReturnType<typeof network>["state"]) => { s.certificate.warnings.push("Private key is readable by other users"); },
  ]) { const { state, services } = network(); change(state); expect(httpsOrigins(services)).toEqual([]); }
});
it("does not advertise a proxy, loopback, LAN or an unrelated VPN address as private Tailnet HTTPS", () => {
  const { state, services } = network();
  state.listeners = ["127.0.0.1", "192.168.1.2", "100.63.1.2", "100.128.1.2", "fd00::1", "::", "0.0.0.0"].map((host) => ({ host, port: 7790, kind: "network" }));
  expect(httpsOrigins(services)).toEqual([]);
});
it("preserves explicitly published browser-trusted HTTPS without needing private TLS", () => {
  const { services, state } = network(); state.settings.tailscale = false;
  services.publishedEndpoints = () => [
    { url: "https://box.ts.net/", label: "HTTPS", reachability: "network", trustedCertificate: true },
    { url: "http://box.ts.net/", label: "HTTP", reachability: "network", trustedCertificate: true },
    { url: "https://untrusted.ts.net/", label: "Untrusted", reachability: "network" },
  ];
  expect(httpsOrigins(services)).toEqual(["https://box.ts.net"]);
});
