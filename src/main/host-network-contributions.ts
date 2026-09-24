import type { UiHostEndpoint, UiHostEndpointKind, UiNetworkAccess } from "../shared/connections.js";
import type { HostNetworkServices } from "./host-extensions.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

/** What the host does when a package's part of network access changes. */
export interface NetworkContributionsHost {
  state(): UiNetworkAccess | undefined;
  /** The proxy hold changed; resolves once the listeners follow. */
  reconcile(): Promise<void>;
  /** Published endpoints changed; resolves once the page origins follow. */
  endpointsChanged(): Promise<void>;
}

/** How `extensionServices` gives each package a `services.network` that speaks for it alone. */
export const BIND_NETWORK_EXTENSION = Symbol("bind-network-extension");

const KINDS: readonly UiHostEndpointKind[] = ["lan", "mdns", "tailscale", "magicdns"];
const MAX_ENDPOINTS = 8;
const STORE_VERSION = 1;

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

function decodeKept(value: unknown): string[] | undefined {
  const { kept } = (value ?? {}) as { kept?: unknown };
  return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200) : undefined;
}

/**
 * The part of network access packages hold: holds on the proxy listener,
 * the packages that keep it open across restarts, and endpoints only they
 * know. Created before the listeners exist; `bind` wires it to them once they
 * do, and whatever was asked for meanwhile applies then.
 */
export class NetworkContributions {
  private host: NetworkContributionsHost | undefined;
  private readonly holds = new Set<symbol>();
  /** Packages that keep the proxy listener, so it opens at start before any package runs. */
  private readonly kept = new Set<string>();
  private readonly published = new Map<symbol, UiHostEndpoint[]>();

  /** `storePath` keeps the packages that keep the proxy listener (`<userData>/network-kept.json`). */
  constructor(private readonly options: { storePath?: string; logger?: PersistedJsonLogger } = {}) {}

  /** Reads which packages keep the proxy listener; before the listeners open. */
  async load(): Promise<void> {
    if (!this.options.storePath) return;
    const stored = await readPersistedJson(this.options.storePath, { expectedVersion: STORE_VERSION, decode: decodeKept, ...(this.options.logger ? { logger: this.options.logger } : {}) });
    for (const id of stored?.data ?? []) this.kept.add(id);
  }

  bind(host: NetworkContributionsHost): void {
    this.host = host;
  }

  get proxyHeld(): boolean {
    return this.holds.size > 0 || this.kept.size > 0;
  }

  endpoints(): UiHostEndpoint[] {
    return [...this.published.values()].flat();
  }

  /** The seam one package sees as `services.network`: `keepProxy` speaks for that package alone. */
  forExtension(extensionId: string): HostNetworkServices {
    const { state, holdProxy, publishEndpoints } = this.services;
    return { state, holdProxy, publishEndpoints, keepProxy: (keep) => this.keep(extensionId, keep) };
  }

  /** The seam without a package's identity; `extensionServices` binds one. */
  readonly services: HostNetworkServices & { [BIND_NETWORK_EXTENSION]: (extensionId: string) => HostNetworkServices } = {
    [BIND_NETWORK_EXTENSION]: (extensionId: string) => this.forExtension(extensionId),
    state: () => this.host?.state(),
    holdProxy: async () => {
      const hold = Symbol("proxy-hold");
      const before = this.proxyHeld;
      this.holds.add(hold);
      if (!before) await this.host?.reconcile();
      return () => {
        if (!this.holds.delete(hold) || this.proxyHeld) return;
        void this.host?.reconcile().catch(() => undefined);
      };
    },
    keepProxy: async () => { throw new Error("keepProxy speaks for one package; call it through that package's services."); },
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

  private async keep(extensionId: string, keep: boolean): Promise<void> {
    if (keep === this.kept.has(extensionId)) return;
    const before = this.proxyHeld;
    if (keep) this.kept.add(extensionId);
    else this.kept.delete(extensionId);
    if (this.options.storePath) {
      await writePersistedJson(this.options.storePath, STORE_VERSION, { kept: [...this.kept].sort() }, this.options.logger ? { logger: this.options.logger } : {});
    }
    if (before !== this.proxyHeld) await this.host?.reconcile();
  }
}
