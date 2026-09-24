import { networkInterfaces } from "node:os";
import {
  pairingUrl,
  type UiConnections,
  type UiCreatedPairingLink,
  type UiHostEndpoint,
  type UiNetworkAccess,
  type UiNetworkSettingsInput,
} from "../shared/connections.js";
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
  /** Replaceable for tests; the machine's own otherwise. */
  interfaces?(): Interfaces;
  names?(interfaces: Interfaces): Promise<EndpointNames>;
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

/** Every endpoint of the host's own listener and of network access, best first. */
async function allEndpoints(connections: HostConnectionsService, info: HostListenInfo | undefined): Promise<UiHostEndpoint[]> {
  const interfaces = connections.interfaces?.() ?? networkInterfaces();
  const beyondLoopback = (info !== undefined && !isLoopbackHost(info.host)) || (connections.network?.state().listeners.length ?? 0) > 0;
  const names = beyondLoopback ? await (connections.names ?? machineNames)(interfaces) : {};
  return mergeEndpoints([info ? hostEndpoints(info, interfaces, names) : [], connections.network?.endpoints(names) ?? []]);
}

function forbidden(): never {
  throw Object.assign(new Error("Only a connection with the host token manages who may connect."), { code: HOST_ERROR.forbidden });
}

function unavailable(message = "This host has no socket listener, so no other client can connect to it."): never {
  throw Object.assign(new Error(message), { code: HOST_ERROR.unsupported });
}

function decodeLinkInput(value: unknown): { label?: string; lifetimeMs?: number } {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("connections-create-link: input must be an object.");
  const { label, lifetimeMs } = value as { label?: unknown; lifetimeMs?: unknown };
  const text = decodeOptionalText("connections-create-link", "label", label);
  if (lifetimeMs !== undefined && (typeof lifetimeMs !== "number" || !Number.isFinite(lifetimeMs))) {
    throw new Error("connections-create-link: lifetimeMs must be a number.");
  }
  return { ...(text ? { label: text } : {}), ...(typeof lifetimeMs === "number" ? { lifetimeMs } : {}) };
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
      const { access, listen, network } = connections;
      const info = listen();
      return {
        scheme: info?.scheme ?? "ws",
        endpoints: await allEndpoints(connections, info),
        webClient: info?.webClient ?? false,
        ...(info?.fingerprint ? { fingerprint: info.fingerprint } : {}),
        tokenPath: access.tokenPath,
        ...(network ? { network: network.state() } : {}),
        ...access.overview(connection),
      };
    }),
    "connections-create-link": owned(async (connections, params): Promise<UiCreatedPairingLink> => {
      const input = decodeLinkInput(params[0]);
      const info = connections.listen();
      const endpoints = info?.webClient ? await allEndpoints(connections, info) : [];
      const { link, code } = connections.access.createLink(input);
      const urls = endpoints.map((endpoint) => ({ ...endpoint, url: pairingUrl(endpoint.url, code) }));
      return { link, code, urls };
    }),
    "connections-revoke-link": owned(({ access }, params) =>
      ({ revoked: access.revokeLink(decodeString("connections-revoke-link", "id", params[0])) })),
    "connections-revoke-client": owned(async ({ access }, params) =>
      ({ revoked: await access.revokeClient(decodeString("connections-revoke-client", "id", params[0])) })),
    "connections-set-network": owned(({ network }, params) => {
      if (!network) unavailable("This host opens no network listeners of its own.");
      return network.update(decodeNetworkSettingsInput(params[0]));
    }),
    "connections-reload-certificate": owned(async ({ reloadCertificates }) => {
      if (!reloadCertificates) unavailable("This host serves no certificate to reload.");
      return reloadCertificates();
    }),
    // The caller keeps its connection and is answered the new token; it already held the old one.
    "connections-rotate-host-token": owned(({ access }, _params, connection) => ({ token: access.rotateHostToken(connection) })),
  };
}
