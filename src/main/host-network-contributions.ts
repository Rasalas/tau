import type { UiHostEndpoint, UiHostEndpointKind, UiNetworkAccess } from "../shared/connections.js";
import type { HostNetworkServices } from "./host-extensions.js";

/** What the host does when a package's part of network access changes. */
export interface NetworkContributionsHost {
  state(): UiNetworkAccess | undefined;
  /** The proxy hold changed; resolves once the listeners follow. */
  reconcile(): Promise<void>;
  /** Published endpoints changed; resolves once the page origins follow. */
  endpointsChanged(): Promise<void>;
}

const KINDS: readonly UiHostEndpointKind[] = ["lan", "mdns", "tailscale", "magicdns"];
const MAX_ENDPOINTS = 8;

/** A published endpoint as core lists it, or undefined for anything it would not offer a device. */
export function acceptedEndpoint(value: unknown): UiHostEndpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { url, label, kind, trustedCertificate } = value as Record<string, unknown>;
  if (typeof url !== "string" || typeof label !== "string" || !label.trim() || label.length > 60) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password || parsed.hash) return undefined;
  return {
    url: parsed.toString(),
    label: label.trim(),
    reachability: "network",
    ...(typeof kind === "string" && (KINDS as readonly string[]).includes(kind) ? { kind: kind as UiHostEndpointKind } : {}),
    ...(trustedCertificate === true && parsed.protocol === "https:" ? { trustedCertificate: true } : {}),
  };
}

/**
 * The part of network access packages hold: holds on the proxy listener and
 * endpoints only they know. Created before the listeners exist; `bind` wires
 * it to them once they do, and whatever was asked for meanwhile applies then.
 */
export class NetworkContributions {
  private host: NetworkContributionsHost | undefined;
  private readonly holds = new Set<symbol>();
  private readonly published = new Map<symbol, UiHostEndpoint[]>();

  bind(host: NetworkContributionsHost): void {
    this.host = host;
  }

  get proxyHeld(): boolean {
    return this.holds.size > 0;
  }

  endpoints(): UiHostEndpoint[] {
    return [...this.published.values()].flat();
  }

  /** The seam a package sees as `services.network`. */
  readonly services: HostNetworkServices = {
    state: () => this.host?.state(),
    holdProxy: async () => {
      const hold = Symbol("proxy-hold");
      this.holds.add(hold);
      if (this.holds.size === 1) await this.host?.reconcile();
      return () => {
        if (!this.holds.delete(hold) || this.holds.size > 0) return;
        void this.host?.reconcile().catch(() => undefined);
      };
    },
    publishEndpoints: (endpoints) => {
      const entry = Symbol("endpoints");
      const accepted = (Array.isArray(endpoints) ? endpoints : []).slice(0, MAX_ENDPOINTS).flatMap((endpoint) => acceptedEndpoint(endpoint) ?? []);
      this.published.set(entry, accepted);
      void this.host?.endpointsChanged().catch(() => undefined);
      return () => {
        if (!this.published.delete(entry)) return;
        void this.host?.endpointsChanged().catch(() => undefined);
      };
    },
  };
}
