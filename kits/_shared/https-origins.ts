import { isIP } from "node:net";
import type { HostNetworkServices } from "tau/host-extension";

/** HTTP audiences on owner-enabled HTTPS. A private CA still needs device-side trust. */
export function httpsOrigins(network: HostNetworkServices | undefined): string[] {
  const origins = new Set<string>();
  for (const endpoint of network?.publishedEndpoints?.() ?? []) {
    if (endpoint.reachability !== "network" || !endpoint.trustedCertificate) continue;
    try { const url = new URL(endpoint.url); if (url.protocol === "https:") origins.add(url.origin); } catch { /* Not an HTTPS endpoint. */ }
  }
  const state = network?.state?.();
  // Only an explicitly supplied certificate on Tailnet-only listeners qualifies.
  // Keep this local to HTTP audiences: native device pairing retains its key pins.
  if (!state?.settings.tailscale || state.settings.lan || !state.settings.certificate
    || state.certificate?.source !== "supplied" || state.certificate.certPath !== state.settings.certificate.certPath
    || state.certificate.warnings.length || !(Date.parse(state.certificate.validTo) > Date.now())) return [...origins];
  for (const listener of state.listeners) {
    if (listener.kind !== "network") continue;
    const { host, port } = listener;
    const parts = host.split(".").map(Number);
    const v4 = isIP(host) === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
    const v6 = isIP(host) === 6 && /^fd7a:115c:a1e0:/iu.test(host);
    if ((v4 || v6) && Number.isInteger(port) && port > 0 && port <= 65535) origins.add(`https://${v6 ? `[${host}]` : host}:${port}`);
  }
  return [...origins];
}
