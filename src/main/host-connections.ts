import { HOST_FACTORY_COMMANDS } from "../shared/host-factory-commands.js";
import type { HostCommand } from "../shared/host-command-definition.js";
import { bindHostCommand } from "./host-command-handler.js";
import { networkInterfaces } from "node:os";
import {
  pairingUrl,
  type PairingEndpoint,
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
import { MagicDnsNames, isTailscaleAddress, linkEndpoints, listenerEndpoints, localHostName, mergeEndpoints, type EndpointNames, type Interfaces } from "./host-endpoints.js";

/** Where a listening host can be reached, known once its socket is up. */
export interface HostListenInfo {
  scheme: "ws" | "wss";
  /** The address it bound, as `TAU_HOST_LISTEN` named it. */
  host: string;
  port: number;
  /** The browser client is built and served on the same port. */
  webClient: boolean;
  fingerprint?: string;
  publicKey?: string;
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
  return (await publishedEndpoints(connections)).origins;
}

/**
 * The origins for the socket's check, and the addresses another machine can
 * dial, as a hello tells them to a client that saved this host (ADR 0025).
 */
export async function publishedEndpoints(connections: HostConnectionsService): Promise<{ origins: string[]; network: PairingEndpoint[] }> {
  const endpoints = await allEndpoints(connections, connections.listen());
  return {
    origins: [...new Set(endpoints.map((endpoint) => new URL(endpoint.url).origin.toLowerCase()))],
    network: networkOnly(endpoints),
  };
}

function networkOnly(endpoints: readonly UiHostEndpoint[]): PairingEndpoint[] {
  return endpoints.filter((endpoint) => endpoint.reachability === "network").map(pairingEndpoint);
}

/** Every endpoint of the host's own listener and of network access, best first. */
/** What a pairing link or a device keeps of an endpoint: the address, its kind, and whether a CA vouches for it. */
function pairingEndpoint(endpoint: UiHostEndpoint): PairingEndpoint {
  return { url: endpoint.url, ...(endpoint.kind ? { kind: endpoint.kind } : {}), ...(endpoint.trustedCertificate ? { trustedCertificate: true } : {}) };
}

async function allEndpoints(connections: HostConnectionsService, info: HostListenInfo | undefined): Promise<UiHostEndpoint[]> {
  const interfaces = connections.interfaces?.() ?? networkInterfaces();
  const beyondLoopback = (info !== undefined && !isLoopbackHost(info.host)) || (connections.network?.state().listeners.length ?? 0) > 0;
  const names = beyondLoopback ? await (connections.names ?? machineNames)(interfaces) : {};
  return mergeEndpoints([connections.published?.() ?? [], info ? hostEndpoints(info, interfaces, names) : [], connections.network?.endpoints(names) ?? []]);
}

function forbidden(): never {
  throw Object.assign(new Error("Only a connection with the access key, on this machine, manages who may connect."), { code: HOST_ERROR.forbidden });
}

function unavailable(message = "This host has no socket listener, so no other client can connect to it."): never {
  throw Object.assign(new Error(message), { code: HOST_ERROR.unsupported });
}

type Method = (params: readonly unknown[], context: HostMethodContext) => Promise<unknown>;

/** Settings → Connections over the protocol. Every method is the owner's alone. */
export function createConnectionsMethods(service: () => HostConnectionsService | undefined): Record<string, Method> {
  const owned = <Args extends readonly unknown[], Result, WireArgs extends readonly unknown[] | never>(
    definition: HostCommand<Args, Result, WireArgs>,
    run: (connections: HostConnectionsService, params: Args, connection: string | undefined) => Result | Promise<Result>,
  ): Method => async (params, context) => {
    if (!isHostOwner(context.principal)) forbidden();
    const connections = service() ?? unavailable();
    if (definition === (HOST_FACTORY_COMMANDS["connections-set-network"] as unknown) && !connections.network) unavailable("This host opens no network listeners of its own.");
    if (definition === (HOST_FACTORY_COMMANDS["connections-discover"] as unknown) && !connections.discover) unavailable("This host cannot look for machines on its network.");
    const connection = context.principal.kind === "workbench-client" ? context.principal.connection : undefined;
    return bindHostCommand(definition, (args) => run(connections, args, connection))(params, context);
  };
  return {
    "connections-list": owned(HOST_FACTORY_COMMANDS["connections-list"], async (connections, _params, connection): Promise<UiConnections> => {
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
    // Every link names the best network address of each kind and the host's key, so a device can pick one and pin it.
    // Also without a web client: the app pairs over the socket.
    "connections-create-link": owned(HOST_FACTORY_COMMANDS["connections-create-link"], async (connections, params): Promise<UiCreatedPairingLink> => {
      const input = params[0];
      const info = connections.listen();
      const endpoints = await allEndpoints(connections, info);
      const { link, code } = connections.access.createLink(input);
      // The network listeners' certificate is the one a phone meets; the host's own listener is loopback in the app.
      const certificate = connections.network?.state().certificate;
      const fingerprint = certificate?.fingerprint ?? info?.fingerprint;
      const publicKey = certificate ? certificate.publicKey : info?.publicKey;
      // A phone that dialled loopback would reach itself; only a loopback link names loopback.
      const network = linkEndpoints(networkOnly(endpoints));
      const urls = endpoints.map((endpoint) => ({
        ...endpoint,
        url: pairingUrl(pairingEndpoint(endpoint), {
          code,
          ...(fingerprint ? { fingerprint } : {}),
          ...(publicKey ? { publicKey } : {}),
          ...(connections.hostId ? { hostId: connections.hostId } : {}),
          ...(connections.hostName ? { hostName: connections.hostName } : {}),
          endpoints: endpoint.reachability === "network" ? network : [],
        }),
      }));
      return { link, code, urls };
    }),
    "connections-revoke-link": owned(HOST_FACTORY_COMMANDS["connections-revoke-link"], ({ access }, params) =>
      ({ revoked: access.revokeLink(params[0]) })),
    "connections-revoke-client": owned(HOST_FACTORY_COMMANDS["connections-revoke-client"], async ({ access }, params) =>
      ({ revoked: await access.revokeClient(params[0]) })),
    "connections-revoke-others": owned(HOST_FACTORY_COMMANDS["connections-revoke-others"], async ({ access }) => ({ revoked: await access.revokeOtherClients() })),
    "connections-update-client": owned(HOST_FACTORY_COMMANDS["connections-update-client"], async ({ access }, params) => ({
      updated: await access.updateClient(params[0], params[1]),
    })),
    // False when the device stopped waiting: it expired, left, or someone else answered first.
    "connections-approve": owned(HOST_FACTORY_COMMANDS["connections-approve"], async ({ access }, params) => ({
      approved: await access.approvePairing(params[0], params[1]),
    })),
    "connections-deny": owned(HOST_FACTORY_COMMANDS["connections-deny"], ({ access }, params) => ({ denied: access.denyPairing(params[0]) })),
    "connections-set-network": owned(HOST_FACTORY_COMMANDS["connections-set-network"], ({ network }, params) => {
      if (!network) unavailable("This host opens no network listeners of its own.");
      return network.update(params[0]);
    }),
    // Browsing is a local network operation macOS asks about; only the owner's click starts one.
    "connections-discover": owned(HOST_FACTORY_COMMANDS["connections-discover"], async ({ discover }, params) => {
      if (!discover) unavailable("This host cannot look for machines on its network.");
      return discover(params[0]);
    }),
    "connections-reload-certificate": owned(HOST_FACTORY_COMMANDS["connections-reload-certificate"], async ({ reloadCertificates }) => {
      if (!reloadCertificates) unavailable("This host serves no certificate to reload.");
      return reloadCertificates();
    }),
    // The key itself, for the owner to sign another browser in. It never runs as a job, whose result goes to every client.
    "connections-host-token": owned(HOST_FACTORY_COMMANDS["connections-host-token"], ({ access }) => ({ token: access.hostToken() })),
    // The caller keeps its connection and is answered the new token; it already held the old one.
    "connections-rotate-host-token": owned(HOST_FACTORY_COMMANDS["connections-rotate-host-token"], ({ access }, _params, connection) => ({ token: access.rotateHostToken(connection) })),
  };
}
