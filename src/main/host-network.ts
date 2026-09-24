import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server as TlsServer } from "node:tls";
import {
  DEFAULT_NETWORK_SETTINGS,
  type UiHostEndpoint,
  type UiNetworkAccess,
  type UiNetworkListener,
  type UiNetworkSettings,
  type UiNetworkSettingsInput,
} from "../shared/connections.js";
import { isTailscaleAddress, listenerEndpoints, type EndpointNames, type Interfaces } from "./host-endpoints.js";
import type { ListenerTrust } from "./host-local-files.js";
import { HostTlsReloader, resolveHostTls, type HostTlsMaterial } from "./host-tls.js";
import { createProtocolServer } from "./host-transport-socket.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";
import type { HostLogger } from "./host-log.js";

const STORE_VERSION = 1;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

/** One listener the settings ask for. */
export interface NetworkBind {
  key: string;
  host: string;
  port: number;
  kind: UiNetworkListener["kind"];
}

/**
 * The listeners network access asks for with these interfaces up. Local
 * network is one dual-stack wildcard; Tailscale alone binds each Tailscale
 * address, so the port stays closed on the LAN; either way Tailscale adds the
 * loopback listener a reverse proxy forwards to.
 */
export function planNetworkBinds(settings: UiNetworkSettings, interfaces: Interfaces): NetworkBind[] {
  const binds: NetworkBind[] = [];
  if (settings.lan) binds.push({ key: "lan", host: "::", port: settings.port, kind: "network" });
  if (settings.tailscale && !settings.lan) {
    for (const address of tailscaleAddresses(interfaces)) binds.push({ key: `tailscale:${address}`, host: address, port: settings.port, kind: "network" });
  }
  if (settings.tailscale) binds.push({ key: "proxy", host: "127.0.0.1", port: settings.proxyPort, kind: "proxy" });
  return binds;
}

function tailscaleAddresses(interfaces: Interfaces): string[] {
  return Object.values(interfaces).flat()
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined && !entry.internal && isTailscaleAddress(entry.address))
    .map((entry) => entry.address);
}

function decodePort(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    throw new Error(`${field} must be a whole number from ${MIN_PORT} to ${MAX_PORT}.`);
  }
  return value;
}

function decodeCertificate(value: unknown): UiNetworkSettings["certificate"] | null | undefined {
  if (value === undefined || value === null) return value;
  const { certPath, keyPath } = (value ?? {}) as { certPath?: unknown; keyPath?: unknown };
  if (typeof certPath !== "string" || typeof keyPath !== "string" || !certPath.trim() || !keyPath.trim()) {
    throw new Error("A certificate names a certificate file and its key file.");
  }
  return { certPath: certPath.trim(), keyPath: keyPath.trim() };
}

/** A change as a client sends it; throws on anything but the known fields in range. */
export function decodeNetworkSettingsInput(value: unknown): UiNetworkSettingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("connections-set-network: input must be an object.");
  const input = value as Record<string, unknown>;
  const result: UiNetworkSettingsInput = {};
  for (const flag of ["lan", "tailscale"] as const) {
    if (input[flag] === undefined) continue;
    if (typeof input[flag] !== "boolean") throw new Error(`connections-set-network: ${flag} must be true or false.`);
    result[flag] = input[flag];
  }
  const port = decodePort(input.port, "The port");
  const proxyPort = decodePort(input.proxyPort, "The proxy port");
  if (port !== undefined) result.port = port;
  if (proxyPort !== undefined) result.proxyPort = proxyPort;
  const certificate = decodeCertificate(input.certificate);
  if (certificate !== undefined) result.certificate = certificate;
  return result;
}

export function applyNetworkSettings(current: UiNetworkSettings, input: UiNetworkSettingsInput): UiNetworkSettings {
  const { certificate, ...rest } = input;
  const next: UiNetworkSettings = { ...current, ...rest };
  if (certificate === null) delete next.certificate;
  else if (certificate) next.certificate = certificate;
  if (next.port === next.proxyPort) throw new Error("The proxy port has to differ from the network port.");
  return next;
}

function decodeStored(value: unknown): UiNetworkSettings | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { settings } = value as { settings?: unknown };
  try {
    return applyNetworkSettings(DEFAULT_NETWORK_SETTINGS, decodeNetworkSettingsInput(settings ?? {}));
  } catch {
    return undefined;
  }
}

export interface HostNetworkAccessOptions {
  /** `<userData>/network.json` holds the settings; the self-signed certificate lives in `<userData>/tls/`. */
  userData: string;
  /** Serves the protocol on a listener's server; the returned function stops that and closes its connections. */
  attach(server: Server, trust: ListenerTrust): () => void;
  /** The web client's handler for a listener, when the client is built. */
  web?: (trust: ListenerTrust) => RequestListener;
  interfaces?: () => Interfaces;
  /** Which listeners the settings mean; tests bind loopback in place of real interfaces. */
  plan?: (settings: UiNetworkSettings, interfaces: Interfaces) => NetworkBind[];
  /** The certificate for a network listener; the settings' own one, else self-signed. */
  resolveTls?: (settings: UiNetworkSettings) => HostTlsMaterial;
  logger?: HostLogger & PersistedJsonLogger;
}

interface OpenListener {
  bind: NetworkBind;
  /** What it actually bound: `0.0.0.0` where `::` is not available. */
  host: string;
  server: Server;
  detach(): void;
  untrack?(): void;
}

/**
 * The listeners network access opens beside the host's own loopback one, and
 * the settings behind them. Changing a switch opens or closes listeners in the
 * running host; closing one closes every connection that came through it.
 * Anything beyond loopback speaks TLS and nothing else, and a listener that
 * cannot open is reported, never replaced by a plaintext one.
 */
export class HostNetworkAccess {
  private settings: UiNetworkSettings = DEFAULT_NETWORK_SETTINGS;
  private readonly open = new Map<string, OpenListener>();
  private problems: string[] = [];
  private tls: HostTlsReloader | undefined;
  /** The settings the current certificate was read for. */
  private tlsFor: string | undefined;
  private tlsProblem: string | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly options: HostNetworkAccessOptions) {}

  static async open(options: HostNetworkAccessOptions): Promise<HostNetworkAccess> {
    const access = new HostNetworkAccess(options);
    const stored = await readPersistedJson(access.path, { expectedVersion: STORE_VERSION, decode: decodeStored, ...(options.logger ? { logger: options.logger } : {}) });
    if (stored) access.settings = stored.data;
    await access.reconcile();
    return access;
  }

  private get path(): string {
    return join(this.options.userData, "network.json");
  }

  private interfaces(): Interfaces {
    return (this.options.interfaces ?? networkInterfaces)();
  }

  /** Validates, keeps and applies a change; a certificate that does not load is refused before anything is kept. */
  update(input: UiNetworkSettingsInput): Promise<UiNetworkAccess> {
    return this.serialize(async () => {
      const next = applyNetworkSettings(this.settings, input);
      if (input.certificate) {
        try { this.resolveTls(next); } catch (error: unknown) { throw new Error(`The certificate did not load: ${messageOf(error)}`, { cause: error }); }
      }
      await writePersistedJson(this.path, STORE_VERSION, { settings: next }, this.options.logger ? { logger: this.options.logger } : {});
      this.settings = next;
      await this.reconcileNow();
      return this.state();
    });
  }

  /** Opens what the settings ask for and is not open, closes what is open and no longer asked for. */
  reconcile(): Promise<void> {
    return this.serialize(() => this.reconcileNow());
  }

  /** Reads the certificate again; answers whether the listeners now serve another one. */
  reloadCertificate(): Promise<{ changed: boolean; network: UiNetworkAccess }> {
    return this.serialize(async () => {
      if (!this.tls) return { changed: false, network: this.state() };
      try {
        const changed = this.tls.reload();
        this.tlsProblem = undefined;
        return { changed, network: this.state() };
      } catch (error: unknown) {
        this.tlsProblem = `The certificate did not load, so the old one is still served: ${messageOf(error)}`;
        throw error;
      }
    });
  }

  /** The periodic look: Tailscale addresses that came or went, a certificate renewed on disk. */
  poll(): Promise<void> {
    return this.serialize(async () => {
      try {
        if (this.tls?.refresh()) this.options.logger?.info("host-network.certificate-reloaded", { fingerprint: this.tls.current.fingerprint });
        this.tlsProblem = undefined;
      } catch (error: unknown) {
        this.tlsProblem = `The certificate changed on disk but did not load, so the old one is still served: ${messageOf(error)}`;
        this.options.logger?.warn("host-network.certificate-reload-failed", error);
      }
      await this.reconcileNow();
    });
  }

  state(): UiNetworkAccess {
    const material = this.tls?.current;
    return {
      settings: this.settings,
      listeners: [...this.open.values()].map(({ bind, host, server }) => ({ host, port: portOf(server) ?? bind.port, kind: bind.kind })),
      problems: [...this.problems, ...(this.tlsProblem ? [this.tlsProblem] : [])],
      tailscaleUp: tailscaleAddresses(this.interfaces()).length > 0,
      ...(material ? {
        certificate: { source: material.source, fingerprint: material.fingerprint, validTo: material.validTo, certPath: material.certPath, warnings: material.warnings },
      } : {}),
    };
  }

  /** The URLs the network listeners are reachable at; the proxy listener is only for the proxy. */
  endpoints(names: EndpointNames): UiHostEndpoint[] {
    const interfaces = this.interfaces();
    return [...this.open.values()]
      .filter(({ bind }) => bind.kind === "network")
      .flatMap(({ host, server }) => listenerEndpoints({ scheme: "https", host, port: portOf(server) ?? 0 }, interfaces, names, { loopback: false }));
  }

  /** The certificate network listeners serve, once one was needed. */
  get fingerprint(): string | undefined {
    return this.tls?.current.fingerprint;
  }

  async close(): Promise<void> {
    await this.serialize(async () => {
      for (const key of [...this.open.keys()]) await this.stop(key);
    });
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async reconcileNow(): Promise<void> {
    const plan = (this.options.plan ?? planNetworkBinds)(this.settings, this.interfaces());
    const wanted = new Map(plan.map((bind) => [bind.key, bind]));
    const problems: string[] = [];
    if (this.settings.tailscale && !this.settings.lan && !plan.some((bind) => bind.key.startsWith("tailscale:"))) {
      problems.push("Tailscale has no address on this machine; Tau listens on it once it has one.");
    }
    const secure = plan.some((bind) => bind.kind === "network");
    const tlsKey = JSON.stringify(this.settings.certificate ?? null);
    // A certificate switched in the settings is a new reloader; the old listeners go with it.
    if (this.tls && (!secure || this.tlsFor !== tlsKey)) {
      for (const [key, open] of [...this.open]) if (open.bind.kind === "network") await this.stop(key);
      this.tls = undefined;
      this.tlsProblem = undefined;
    }
    if (secure && !this.tls) {
      try {
        const settings = this.settings;
        this.tls = new HostTlsReloader(() => this.resolveTls(settings));
        this.tlsFor = tlsKey;
        this.tlsProblem = undefined;
        for (const warning of this.tls.current.warnings) this.options.logger?.warn("host-network.tls", warning);
      } catch (error: unknown) {
        problems.push(`No network listener opened: the certificate did not load (${messageOf(error)}).`);
      }
    }
    for (const [key, open] of [...this.open]) {
      const bind = wanted.get(key);
      if (!bind || bind.port !== open.bind.port || (bind.kind === "network" && !this.tls)) await this.stop(key);
    }
    for (const bind of plan) {
      if (this.open.has(bind.key)) continue;
      if (bind.kind === "network" && !this.tls) continue;
      try {
        this.open.set(bind.key, await this.start(bind));
      } catch (error: unknown) {
        problems.push(describeListenFailure(bind, error));
        this.options.logger?.warn("host-network.listen-failed", { host: bind.host, port: bind.port, error: messageOf(error) });
      }
    }
    this.problems = problems;
  }

  private resolveTls(settings: UiNetworkSettings): HostTlsMaterial {
    if (this.options.resolveTls) return this.options.resolveTls(settings);
    return resolveHostTls({
      TAU_HOST_TLS: "1",
      ...(settings.certificate ? { TAU_HOST_TLS_CERT: settings.certificate.certPath, TAU_HOST_TLS_KEY: settings.certificate.keyPath } : {}),
    }, { userData: this.options.userData })!;
  }

  private async start(bind: NetworkBind): Promise<OpenListener> {
    const trust: ListenerTrust = bind.kind === "proxy" ? "proxy" : "network";
    const material = bind.kind === "network" ? this.tls!.current : undefined;
    const make = (): Server => {
      const handler = this.options.web?.(trust);
      if (!handler) return createProtocolServer(material ? { cert: material.cert, key: material.key } : undefined);
      return material
        ? createHttpsServer({ cert: material.cert, key: material.key, minVersion: "TLSv1.2" }, handler)
        : createHttpServer(handler);
    };
    let server = make();
    let host = bind.host;
    try {
      await listen(server, bind.port, host);
    } catch (error: unknown) {
      // A machine without IPv6 cannot bind `::`; the IPv4 wildcard still serves the LAN.
      if (bind.host !== "::" || !["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as { code?: string }).code ?? "")) throw error;
      server = make();
      host = "0.0.0.0";
      await listen(server, bind.port, host);
    }
    const detach = this.options.attach(server, trust);
    const untrack = material ? this.tls!.track(server as unknown as TlsServer) : undefined;
    this.options.logger?.info("host-network.listening", { host, port: portOf(server), kind: bind.kind });
    return { bind, host, server, detach, ...(untrack ? { untrack } : {}) };
  }

  private async stop(key: string): Promise<void> {
    const open = this.open.get(key);
    if (!open) return;
    this.open.delete(key);
    open.detach();
    open.untrack?.();
    await new Promise<void>((resolve) => {
      open.server.close(() => resolve());
      // Keep-alive requests of the web client would hold `close` open.
      (open.server as Server & { closeAllConnections?(): void }).closeAllConnections?.();
    });
    this.options.logger?.info("host-network.closed", { host: open.host, port: open.bind.port, kind: open.bind.kind });
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
}

function portOf(server: Server): number | undefined {
  const address = server.address();
  return typeof address === "object" && address ? address.port : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeListenFailure(bind: NetworkBind, error: unknown): string {
  const code = (error as { code?: string }).code;
  const where = bind.kind === "proxy" ? `The proxy listener on 127.0.0.1:${bind.port}` : `The listener on ${bind.host === "::" ? "every interface" : bind.host}, port ${bind.port},`;
  if (code === "EADDRINUSE") return `${where} did not open: another program uses port ${bind.port}.`;
  if (code === "EACCES") return `${where} did not open: this user may not use port ${bind.port}.`;
  return `${where} did not open: ${messageOf(error)}`;
}
