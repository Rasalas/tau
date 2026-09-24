import { networkInterfaces } from "node:os";
import {
  IDLE_TIMEOUT_CHOICES,
  pairingUrl,
  type DeviceAccess,
  type UiClientUpdate,
  type UiConnections,
  type UiCreatedPairingLink,
  type UiHostEndpoint,
  type UiNetworkAccess,
  type UiNetworkSettingsInput,
} from "../shared/connections.js";
import type { UiDiscoveredHosts } from "../shared/discovery.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import type { HostAccess } from "./host-access.js";
import type { HostMethodContext } from "./host-jobs.js";
import { isHostOwner } from "./host-invocation.js";
import { isLoopbackHost } from "./host-listen.js";
import { MagicDnsNames, isTailscaleAddress, listenerEndpoints, localHostName, mergeEndpoints, type EndpointNames, type Interfaces } from "./host-endpoints.js";
import { decodeNetworkSettingsInput } from "./host-network.js";
import { decodeOptionalText, decodeString } from "./ipc-input.js";

/** Where a listening host can be reached, known once its socket is up. */
export interface HostListenInfo {
  scheme: "ws" | "wss";
  /** The address it bound, as `TAU_HOST_LISTEN` named it. */
  host: string;
  port: number;
  /** The browser client is built and served on the same port. */
  webClient: boolean;
  fingerprint?: string;
}

/** The listeners network access opens beside the host's own (`HostNetworkAccess`). */
export interface HostNetworkService {
  state(): UiNetworkAccess;
  endpoints(names: EndpointNames): UiHostEndpoint[];
  update(input: UiNetworkSettingsInput): Promise<UiNetworkAccess>;
}

/** Everything the Connections methods need; a host without a socket listener has none. */
export interface HostConnectionsService {
  access: HostAccess;
  listen(): HostListenInfo | undefined;
  /** Absent on a host that opens no listeners of its own. */
  network?: HostNetworkService;
  /** Reads every listener's certificate again; answers whether one changed. */
  reloadCertificates?(): Promise<{ changed: boolean }>;
  /** Endpoints packages published (`services.network.publishEndpoints`). */
  published?(): UiHostEndpoint[];
  /** Replaceable for tests; the machine's own otherwise. */
  interfaces?(): Interfaces;
  names?(interfaces: Interfaces): Promise<EndpointNames>;
  /** Carried in a pairing link and the Bonjour record, so a device recognises the host again. */
  hostId?: string;
  hostName?: string;
  /** Looks for Tau hosts on this network for a few seconds; only when the owner asks. */
  discover?(options: { timeoutMs?: number }): Promise<UiDiscoveredHosts>;
}

/** The URLs a browser opens this host's own listener at: every usable address of a wildcard bind, loopback last. */
export function hostEndpoints(listen: HostListenInfo, interfaces: Interfaces = networkInterfaces(), names: EndpointNames = {}): UiHostEndpoint[] {
  return listenerEndpoints({ scheme: listen.scheme === "wss" ? "https" : "http", host: listen.host, port: listen.port }, interfaces, names);
}

const magicDns = new MagicDnsNames();
let localName: string | undefined | null = null;

/** The machine's names, looked up only when some listener is beyond loopback and would be reached by them. */
async function machineNames(interfaces: Interfaces): Promise<EndpointNames> {
  if (localName === null) localName = localHostName();
  const tailscale = Object.values(interfaces).flat().some((entry) => entry && !entry.internal && isTailscaleAddress(entry.address));
  const name = tailscale ? await magicDns.forInterfaces(interfaces) : undefined;
  return { ...(localName ? { localName } : {}), ...(name ? { magicDns: name } : {}) };
}

/**
 * The page origins of every endpoint, for the socket's origin check: a page
 * opened at the `.local` name or the MagicDNS name opens its socket from there.
 */
export async function endpointOrigins(connections: HostConnectionsService): Promise<string[]> {
  const endpoints = await allEndpoints(connections, connections.listen());
  return [...new Set(endpoints.map((endpoint) => new URL(endpoint.url).origin.toLowerCase()))];
}

/** Every endpoint of the host's own listener and of network access, best first. */
async function allEndpoints(connections: HostConnectionsService, info: HostListenInfo | undefined): Promise<UiHostEndpoint[]> {
  const interfaces = connections.interfaces?.() ?? networkInterfaces();
  const beyondLoopback = (info !== undefined && !isLoopbackHost(info.host)) || (connections.network?.state().listeners.length ?? 0) > 0;
  const names = beyondLoopback ? await (connections.names ?? machineNames)(interfaces) : {};
  return mergeEndpoints([connections.published?.() ?? [], info ? hostEndpoints(info, interfaces, names) : [], connections.network?.endpoints(names) ?? []]);
}

function forbidden(): never {
  throw Object.assign(new Error("Only a connection with the host token, on this machine, manages who may connect."), { code: HOST_ERROR.forbidden });
}

function unavailable(message = "This host has no socket listener, so no other client can connect to it."): never {
  throw Object.assign(new Error(message), { code: HOST_ERROR.unsupported });
}

function decodeObject(method: string, value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${method}: input must be an object.`);
  return value as Record<string, unknown>;
}

function decodeAccess(method: string, value: unknown): DeviceAccess | undefined {
  if (value === undefined) return undefined;
  if (value !== "full" && value !== "read-only") throw new Error(`${method}: access must be "full" or "read-only".`);
  return value;
}

function decodeLinkInput(value: unknown): { label?: string; lifetimeMs?: number; access?: DeviceAccess } {
  const { label, lifetimeMs, access } = decodeObject("connections-create-link", value);
  const text = decodeOptionalText("connections-create-link", "label", label);
  if (lifetimeMs !== undefined && (typeof lifetimeMs !== "number" || !Number.isFinite(lifetimeMs))) {
    throw new Error("connections-create-link: lifetimeMs must be a number.");
  }
  const preset = decodeAccess("connections-create-link", access);
  return { ...(text ? { label: text } : {}), ...(typeof lifetimeMs === "number" ? { lifetimeMs } : {}), ...(preset ? { access: preset } : {}) };
}

function decodeApproval(value: unknown): { access?: DeviceAccess; label?: string } {
  const { access, label } = decodeObject("connections-approve", value);
  const preset = decodeAccess("connections-approve", access);
  const text = decodeOptionalText("connections-approve", "label", label);
  return { ...(preset ? { access: preset } : {}), ...(text ? { label: text } : {}) };
}

function decodeClientUpdate(value: unknown): UiClientUpdate {
  const { label, access, idleTimeoutDays } = decodeObject("connections-update-client", value);
  const text = decodeOptionalText("connections-update-client", "label", label);
  const preset = decodeAccess("connections-update-client", access);
  if (idleTimeoutDays !== undefined && !(IDLE_TIMEOUT_CHOICES as readonly unknown[]).includes(idleTimeoutDays)) {
    throw new Error("connections-update-client: idleTimeoutDays must be 30, 90, 365 or null.");
  }
  return {
    ...(label !== undefined ? { label: text ?? "" } : {}),
    ...(preset ? { access: preset } : {}),
    ...(idleTimeoutDays !== undefined ? { idleTimeoutDays: idleTimeoutDays as UiClientUpdate["idleTimeoutDays"] } : {}),
  };
}

type Method = (params: readonly unknown[], context: HostMethodContext) => Promise<unknown>;

/** Settings → Connections over the protocol. Every method is the owner's alone. */
export function createConnectionsMethods(service: () => HostConnectionsService | undefined): Record<string, Method> {
  const owned = (run: (connections: HostConnectionsService, params: readonly unknown[], connection: string | undefined) => Promise<unknown> | unknown): Method =>
    async (params, context) => {
      if (!isHostOwner(context.principal)) forbidden();
      const connections = service() ?? unavailable();
      const connection = context.principal.kind === "workbench-client" ? context.principal.connection : undefined;
      return run(connections, params, connection);
    };
  return {
    "connections-list": owned(async (connections, _params, connection): Promise<UiConnections> => {
      const { access, listen, network, hostId } = connections;
      const info = listen();
      return {
        ...(hostId ? { hostId } : {}),
        scheme: info?.scheme ?? "ws",
        endpoints: await allEndpoints(connections, info),
        webClient: info?.webClient ?? false,
        ...(info?.fingerprint ? { fingerprint: info.fingerprint } : {}),
        tokenPath: access.tokenPath,
        ...(network ? { network: network.state() } : {}),
        ...access.overview(connection),
      };
    }),
    // Every link names every network address, its kind and the certificate, so a device can pick one and pin it.
    // Also without a web client: the app pairs over the socket.
    "connections-create-link": owned(async (connections, params): Promise<UiCreatedPairingLink> => {
      const input = decodeLinkInput(params[0]);
      const info = connections.listen();
      const endpoints = await allEndpoints(connections, info);
      const { link, code } = connections.access.createLink(input);
      // The network listeners' certificate is the one a phone meets; the host's own listener is loopback in the app.
      const fingerprint = connections.network?.state().certificate?.fingerprint ?? info?.fingerprint;
      // A phone that dialled loopback would reach itself; only a loopback link names loopback.
      const network = endpoints.filter((endpoint) => endpoint.reachability === "network").map(({ url, kind }) => ({ url, ...(kind ? { kind } : {}) }));
      const urls = endpoints.map((endpoint) => ({
        ...endpoint,
        url: pairingUrl({ url: endpoint.url, ...(endpoint.kind ? { kind: endpoint.kind } : {}) }, {
          code,
          ...(fingerprint ? { fingerprint } : {}),
          ...(connections.hostId ? { hostId: connections.hostId } : {}),
          ...(connections.hostName ? { hostName: connections.hostName } : {}),
          endpoints: endpoint.reachability === "network" ? network : [],
        }),
      }));
      return { link, code, urls };
    }),
    "connections-revoke-link": owned(({ access }, params) =>
      ({ revoked: access.revokeLink(decodeString("connections-revoke-link", "id", params[0])) })),
    "connections-revoke-client": owned(async ({ access }, params) =>
      ({ revoked: await access.revokeClient(decodeString("connections-revoke-client", "id", params[0])) })),
    "connections-revoke-others": owned(async ({ access }) => ({ revoked: await access.revokeOtherClients() })),
    "connections-update-client": owned(async ({ access }, params) => ({
      updated: await access.updateClient(decodeString("connections-update-client", "id", params[0]), decodeClientUpdate(params[1])),
    })),
    // False when the device stopped waiting: it expired, left, or someone else answered first.
    "connections-approve": owned(async ({ access }, params) => ({
      approved: await access.approvePairing(decodeString("connections-approve", "id", params[0]), decodeApproval(params[1])),
    })),
    "connections-deny": owned(({ access }, params) => ({ denied: access.denyPairing(decodeString("connections-deny", "id", params[0])) })),
    "connections-set-network": owned(({ network }, params) => {
      if (!network) unavailable("This host opens no network listeners of its own.");
      return network.update(decodeNetworkSettingsInput(params[0]));
    }),
    // Browsing is a local network operation macOS asks about; only the owner's click starts one.
    "connections-discover": owned(async ({ discover }, params) => {
      if (!discover) unavailable("This host cannot look for machines on its network.");
      const { timeoutMs } = decodeObject("connections-discover", params[0]);
      if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))) throw new Error("connections-discover: timeoutMs must be a number.");
      return discover(typeof timeoutMs === "number" ? { timeoutMs } : {});
    }),
    "connections-reload-certificate": owned(async ({ reloadCertificates }) => {
      if (!reloadCertificates) unavailable("This host serves no certificate to reload.");
      return reloadCertificates();
    }),
    // The caller keeps its connection and is answered the new token; it already held the old one.
    "connections-rotate-host-token": owned(({ access }, _params, connection) => ({ token: access.rotateHostToken(connection) })),
  };
}
