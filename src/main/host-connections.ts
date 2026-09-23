import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { pairingUrl, type UiConnections, type UiCreatedPairingLink, type UiHostEndpoint } from "../shared/connections.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import type { HostAccess } from "./host-access.js";
import type { HostMethodContext } from "./host-jobs.js";
import { isHostOwner } from "./host-invocation.js";
import { isLoopbackHost } from "./host-listen.js";
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

/** Everything the Connections methods need; a host without a socket listener has none. */
export interface HostConnectionsService {
  access: HostAccess;
  listen(): HostListenInfo | undefined;
}

type Interfaces = Record<string, NetworkInterfaceInfo[] | undefined>;

/**
 * The URLs a browser opens this host at. A wildcard bind is reachable on every
 * interface, so each external IPv4 address is one endpoint; loopback always is
 * one, for this machine.
 */
export function hostEndpoints(listen: HostListenInfo, interfaces: Interfaces = networkInterfaces()): UiHostEndpoint[] {
  const scheme = listen.scheme === "wss" ? "https" : "http";
  const url = (address: string) => `${scheme}://${address.includes(":") ? `[${address}]` : address}:${listen.port}/`;
  const bare = listen.host.replace(/^\[|\]$/gu, "");
  if (isLoopbackHost(bare)) return [{ url: url(bare === "localhost" ? "127.0.0.1" : bare), label: "This machine", reachability: "loopback" }];
  if (bare !== "0.0.0.0" && bare !== "::" && bare !== "") return [{ url: url(bare), label: bare, reachability: "network" }];
  const endpoints: UiHostEndpoint[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== "IPv4") continue;
      endpoints.push({ url: url(address.address), label: name, reachability: "network" });
    }
  }
  endpoints.push({ url: url("127.0.0.1"), label: "This machine", reachability: "loopback" });
  return endpoints;
}

function forbidden(): never {
  throw Object.assign(new Error("Only a connection with the host token manages who may connect."), { code: HOST_ERROR.forbidden });
}

function unavailable(): never {
  throw Object.assign(new Error("This host has no socket listener, so no other client can connect to it."), { code: HOST_ERROR.unsupported });
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
    "connections-list": owned(({ access, listen }, _params, connection): UiConnections => {
      const info = listen();
      return {
        scheme: info?.scheme ?? "ws",
        endpoints: info ? hostEndpoints(info) : [],
        webClient: info?.webClient ?? false,
        ...(info?.fingerprint ? { fingerprint: info.fingerprint } : {}),
        tokenPath: access.tokenPath,
        ...access.overview(connection),
      };
    }),
    "connections-create-link": owned(({ access, listen }, params): UiCreatedPairingLink => {
      const { link, code } = access.createLink(decodeLinkInput(params[0]));
      const info = listen();
      const urls = info?.webClient ? hostEndpoints(info).map((endpoint) => ({ ...endpoint, url: pairingUrl(endpoint.url, code) })) : [];
      return { link, code, urls };
    }),
    "connections-revoke-link": owned(({ access }, params) =>
      ({ revoked: access.revokeLink(decodeString("connections-revoke-link", "id", params[0])) })),
    "connections-revoke-client": owned(async ({ access }, params) =>
      ({ revoked: await access.revokeClient(decodeString("connections-revoke-client", "id", params[0])) })),
    // The caller keeps its connection and is answered the new token; it already held the old one.
    "connections-rotate-host-token": owned(({ access }, _params, connection) => ({ token: access.rotateHostToken(connection) })),
  };
}
