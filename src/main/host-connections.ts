import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import {
  IDLE_TIMEOUT_CHOICES,
  pairingUrl,
  type DeviceAccess,
  type UiClientUpdate,
  type UiConnections,
  type UiCreatedPairingLink,
  type UiHostEndpoint,
} from "../shared/connections.js";
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
  /** Carried in a pairing link, so a device recognises the host again (and a Bonjour record can name the same one). */
  hostId?: string;
  hostName?: string;
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
    "connections-list": owned(({ access, listen, hostId }, _params, connection): UiConnections => {
      const info = listen();
      return {
        ...(hostId ? { hostId } : {}),
        scheme: info?.scheme ?? "ws",
        endpoints: info ? hostEndpoints(info) : [],
        webClient: info?.webClient ?? false,
        ...(info?.fingerprint ? { fingerprint: info.fingerprint } : {}),
        tokenPath: access.tokenPath,
        ...access.overview(connection),
      };
    }),
    // Every link names every network address and the certificate, so a device can pick one and pin it.
    "connections-create-link": owned(({ access, listen, hostId, hostName }, params): UiCreatedPairingLink => {
      const { link, code } = access.createLink(decodeLinkInput(params[0]));
      const info = listen();
      const endpoints = info ? hostEndpoints(info) : [];
      // A phone that dialled loopback would reach itself; only a loopback link names loopback.
      const network = endpoints.filter((endpoint) => endpoint.reachability === "network").map((endpoint) => endpoint.url);
      const urls = endpoints.map((endpoint) => ({
        ...endpoint,
        url: pairingUrl(endpoint.url, {
          code,
          ...(info?.fingerprint ? { fingerprint: info.fingerprint } : {}),
          ...(hostId ? { hostId } : {}),
          ...(hostName ? { hostName } : {}),
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
    // The caller keeps its connection and is answered the new token; it already held the old one.
    "connections-rotate-host-token": owned(({ access }, _params, connection) => ({ token: access.rotateHostToken(connection) })),
  };
}
