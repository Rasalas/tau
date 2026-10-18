import { HOST_FACTORY_COMMAND_METADATA } from "./host-command-metadata.js";
import type { TauConfig } from "./contracts.js";
import { attachCommandMetadata, command } from "./host-command-definition.js";
import { decodeString, decodeOptionalText, decodeSettingKeys, decodeHostTranscriptCursor } from "./host-command-input.js";
import { HOST_ERROR } from "./host-transport.js";
import {
  IDLE_TIMEOUT_CHOICES,
  authorityName,
  parsePairingPayload,
  type PairingEndpoint,
  type UiHostEndpointKind,
  type DeviceAccess,
  type UiClientUpdate,
  type UiConnections,
  type UiCreatedPairingLink,
  type UiNetworkSettingsInput,
  type UiNetworkSettings,
  type UiNetworkAccess,
  type UiHostService,
} from "./connections.js";
import { decodeManagedRoute } from "./managed-connections.js";
import type { SavedEnvironment as HostMachineEntry, HostMachine, MachinesOverview, MachinePairResult } from "./machine-protocol.js";
import type { HostResources, HostReadiness } from "./host-resources.js";
import type { ConnectSetup, ConnectStatus } from "./connect.js";
import type { HostUpdateStatus, HostUpdateSettings } from "./host-updates.js";
import type { UiDiscoveredHosts } from "./discovery.js";
import {
  decodeEnvironmentOpenTarget,
  type EnvironmentPairInput,
  type EnvironmentPairResult,
  type EnvironmentPreferences,
  type EnvironmentAgentsResult,
  type EnvironmentTarget,
  type UiEnvironmentThreadView,
  type UiEnvironments,
} from "./environments.js";
import { personPreferences, type PersonPreferences } from "./person-preferences.js";
import type { TranscriptPage } from "./host-protocol.js";
import type { ConfigLayers } from "./config-layers.js";
const failure = (message: string, code: string = HOST_ERROR.invalidRequest): Error => Object.assign(new Error(message), { code });
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


function decodePairInput(value: unknown): { link: string; agents: boolean; name?: string; id?: string } {
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object") throw failure("machines-pair: expected an object.");
  const link = decodeString("machines-pair", "link", item.link);
  if (link.length > 8_192 || !parsePairingPayload(link)) throw failure("machines-pair: link must be a pairing link.");
  const text = (key: string): string | undefined => typeof item[key] === "string" && (item[key] as string).trim() ? (item[key] as string).trim().slice(0, 200) : undefined;
  const name = text("name");
  const id = text("id");
  return { link, agents: item.agents === true, ...(name ? { name } : {}), ...(id ? { id } : {}) };
}


const KINDS = new Set<string>(["loopback", "lan", "mdns", "tailscale", "magicdns"]);

/** What `machines-add` takes: the machine as the window paired it, and the agents' token. */
function decodeMachineEntry(value: unknown): HostMachineEntry {
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object") throw failure("machines-add: expected an object.", HOST_ERROR.invalidRequest);
  const id = decodeString("machines-add", "id", item.id);
  const token = decodeString("machines-add", "token", item.token);
  const endpoints: PairingEndpoint[] = (Array.isArray(item.endpoints) ? item.endpoints : []).flatMap((raw: unknown) => {
    const endpoint = raw as { url?: unknown; kind?: unknown; trustedCertificate?: unknown } | undefined;
    if (typeof endpoint?.url !== "string" || !/^https?:\/\//u.test(endpoint.url)) return [];
    return [{
      url: endpoint.url,
      ...(typeof endpoint.kind === "string" && KINDS.has(endpoint.kind) ? { kind: endpoint.kind as UiHostEndpointKind } : {}),
      ...(endpoint.trustedCertificate === true && authorityName(endpoint.url) ? { trustedCertificate: true } : {}),
    }];
  });
  if (endpoints.length === 0 || endpoints.length > 16) throw failure("machines-add: a machine needs 1 to 16 addresses.", HOST_ERROR.invalidRequest);
  const text = (key: string, max: number): string | undefined => typeof item[key] === "string" && item[key] ? (item[key] as string).slice(0, max) : undefined;
  const connect = decodeManagedRoute(item.managed)?.connect;
  const publicKey = text("publicKey", 200);
  const fingerprint = text("fingerprint", 200);
  const lastUrl = text("lastUrl", 2_048);
  return {
    id: id.slice(0, 200),
    name: text("name", 80) ?? id.slice(0, 8),
    endpoints,
    ...(publicKey ? { publicKey } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    token,
    ...(connect ? { managed: { connect } } : {}),
    addedAt: text("addedAt", 40) ?? new Date().toISOString(),
    ...(lastUrl ? { lastUrl } : {}),
    ...(item.readOnly === true ? { readOnly: true } : {}),
  };
}


function decodeSettings(value: unknown): HostUpdateSettings {
  const item = value as Record<string, unknown> | undefined;
  if (!item || typeof item !== "object") throw Object.assign(new Error("update-settings: expected an object."), { code: HOST_ERROR.invalidRequest });
  const flag = (key: string) => {
    if (item[key] === undefined) return {};
    if (typeof item[key] !== "boolean") throw Object.assign(new Error(`update-settings: ${key} must be true or false.`), { code: HOST_ERROR.invalidRequest });
    return { [key]: item[key] };
  };
  return { ...flag("automatic"), ...flag("devicesMayInstall") };
}


const MIN_PORT = 1024;
const MAX_PORT = 65535;
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
function decodeNetworkSettingsInput(value: unknown): UiNetworkSettingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("connections-set-network: input must be an object.");
  const input = value as Record<string, unknown>;
  const result: UiNetworkSettingsInput = {};
  for (const flag of ["lan", "tailscale", "announce"] as const) {
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

export { decodeMachineEntry, decodeNetworkSettingsInput };


function environmentText(method: string, name: string, value: unknown, max = 4_096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw failure(`${method}: ${name} must be a non-empty string of at most ${max} characters.`);
  return value;
}
function blobText(method: string, field: string, value: unknown): string {
  if (typeof value !== "string") throw failure(`${method}: ${field} must be a string.`);
  return value;
}
function whole(method: string, field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw failure(`${method}: ${field} must be a whole number from 0.`);
  return value;
}

export const HOST_FACTORY_COMMANDS = attachCommandMetadata(HOST_FACTORY_COMMAND_METADATA, {
  "external-mcp-manage": command<unknown, [input: Record<string, unknown>]>()({
    decode: (params) => [decodeObject("external-mcp-manage", params[0])] as const,
  }),
  "connections-list": command<UiConnections>()({
    decode: (_params) => [] as const,
  }),
  "connections-revoke-others": command<{ revoked: number }>()({
    decode: (_params) => [] as const,
  }),
  "connections-reload-certificate": command<{ changed: boolean }>()({
    decode: (_params) => [] as const,
  }),
  "connections-host-token": command<{ token: string }>()({
    decode: (_params) => [] as const,
  }),
  "connections-rotate-host-token": command<{ token: string }>()({
    decode: (_params) => [] as const,
  }),
  "connections-discover": command<UiDiscoveredHosts, [options?: { timeoutMs?: number }]>()({
    decode: (params) => { const { timeoutMs } = decodeObject("connections-discover", params[0]);
    if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs))) throw new Error("connections-discover: timeoutMs must be a number.");
    return [typeof timeoutMs === "number" ? { timeoutMs } : {}] as const; },
  }),
  "connections-create-link": command<UiCreatedPairingLink, [input?: { label?: string; lifetimeMs?: number; access?: DeviceAccess }]>()({
    decode: (params) => [decodeLinkInput(params[0])] as const,
  }),
  "connections-revoke-link": command<{ revoked: boolean }>()({
    decode: (params) => [decodeString("connections-revoke-link", "id", params[0])] as const,
  }),
  "connections-revoke-client": command<{ revoked: boolean }>()({
    decode: (params) => [decodeString("connections-revoke-client", "id", params[0])] as const,
  }),
  "connections-deny": command<{ denied: boolean }>()({
    decode: (params) => [decodeString("connections-deny", "id", params[0])] as const,
  }),
  "connections-update-client": command<{ updated: boolean }>()({
    decode: (params) => [decodeString("connections-update-client", "id", params[0]), decodeClientUpdate(params[1])] as const,
  }),
  "connections-approve": command<{ approved: boolean }, [id: string, choice?: { access?: DeviceAccess; label?: string }]>()({
    decode: (params) => [decodeString("connections-approve", "id", params[0]), decodeApproval(params[1])] as const,
  }),
  "connections-set-network": command<UiNetworkAccess>()({
    decode: (params) => [decodeNetworkSettingsInput(params[0])] as const,
  }),
  "connect-status": command<ConnectStatus>()({
    decode: (_params) => [] as const,
  }),
  "connect-link": command<{ link: string }>()({
    decode: (_params) => [] as const,
  }),
  "connect-remove": command<ConnectStatus>()({
    decode: (_params) => [] as const,
  }),
  "connect-configure": command<ConnectStatus>()({
    decode: (params) => { const input = params[0] as ConnectSetup | undefined;
    if (typeof input?.relay !== "string" || typeof input.enrollmentToken !== "string" || input.relay.length > 2_048 || input.enrollmentToken.length > 128) throw new Error("Tau Connect requires a relay address and enrollment token.");
    return [input] as const; },
  }),
  "service-status": command<UiHostService>()({
    decode: (_params) => [] as const,
  }),
  "service-allow-sandbox": command<UiHostService>()({
    decode: (_params) => [] as const,
  }),
  "service-uninstall": command<UiHostService>()({
    decode: (_params) => [] as const,
  }),
  "service-install": command<UiHostService, [options?: { display?: boolean }]>()({
    decode: (params) => { const option = params[0] as { display?: unknown } | undefined;
    return [typeof option?.display === "boolean" ? { display: option.display } : {}] as const; },
  }),
  "host-resources": command<HostResources>()({
    decode: (_params) => [] as const,
  }),
  "readiness": command<HostReadiness>()({
    decode: (_params) => [] as const,
  }),
  "update-status": command<HostUpdateStatus>()({
    decode: (_params) => [] as const,
  }),
  "update-check": command<HostUpdateStatus>()({
    decode: (_params) => [] as const,
  }),
  "update-install": command<HostUpdateStatus>()({
    audit: { label: "started a Tau update" },
    decode: (_params) => [] as const,
  }),
  "update-settings": command<HostUpdateStatus>()({
    audit: { label: "changed automatic updates" },
    decode: (params) => [decodeSettings(params[0])] as const,
  }),
  "blob-put": command<{ received: number }>()({
    audit: { label: "sent part of a file", automatic: true, quiet: true },
    decode: (params) => [blobText("blob-put", "id", params[0]), whole("blob-put", "index", params[1]), blobText("blob-put", "data", params[2])] as const,
  }),
  "blob-commit": command<{ id: string; size: number; sha256: string }>()({
    audit: { label: "sent a file" },
    decode: (params) => { const sha256 = blobText("blob-commit", "sha256", params[1]);
    if (!/^[0-9a-f]{64}$/iu.test(sha256)) throw failure("blob-commit: sha256 is 64 hex digits.");
    return [blobText("blob-commit", "id", params[0]), sha256, whole("blob-commit", "size", params[2])] as const; },
  }),
  "blob-abort": command<{ aborted: boolean }>()({
    audit: { label: "cancelled sending a file", automatic: true },
    decode: (params) => [blobText("blob-abort", "id", params[0])] as const,
  }),
  "machines-list": command<{ machines: HostMachine[] }>()({
    decode: (_params) => [] as const,
  }),
  "machines-add": command<{ added: boolean }>()({
    decode: (params) => [decodeMachineEntry(params[0])] as const,
  }),
  "machines-remove": command<{ removed: boolean }>()({
    decode: (params) => [decodeString("machines-remove", "id", params[0])] as const,
  }),
  "machines-overview": command<MachinesOverview>()({
    decode: (_params) => [] as const,
  }),
  "machines-pair": command<MachinePairResult, [input: { link: string; agents?: boolean; name?: string; id?: string }]>()({
    decode: (params) => [decodePairInput(params[0])] as const,
  }),
  "machines-update": command<{ id: string; name: string; update: HostUpdateStatus }, [machine: string, action?: "status" | "check" | "install"]>()({
    decode: (params) => { const action = params[1] ?? "install";
    if (action !== "status" && action !== "check" && action !== "install") throw failure("machines-update: action must be status, check or install.");
    return [decodeString("machines-update", "machine", params[0]), action] as const; },
  }),
  "machines-forget": command<{ id: string; name: string; window: boolean; agents: boolean }>()({
    decode: (params) => [decodeString("machines-forget", "machine", params[0])] as const,
  }),
  "environments-list": command<UiEnvironments>()({
    decode: (_params) => [] as const,
  }),
  "environments-discover": command<UiDiscoveredHosts>()({
    audit: { label: "looked for machines" },
    decode: (_params) => [] as const,
  }),
  "environments-wsl-list": command<string[]>()({
    decode: (_params) => [] as const,
  }),
  "environments-cancel-pairing": command<void>()({
    audit: { label: "cancelled pairing a machine" },
    decode: (_params) => [] as const,
  }),
  "environments-take-arrival": command<EnvironmentTarget | null>()({
    decode: (_params) => [] as const,
  }),
  "environments-person-preferences": command<PersonPreferences>()({
    decode: (_params) => [] as const,
  }),
  "environments-pair": command<EnvironmentPairResult>()({
    audit: { label: "paired a machine" },
    decode: (params) => { const input = params[0] as { text?: unknown; nearby?: unknown; ssh?: unknown; wsl?: unknown; deviceName?: unknown; agents?: unknown } | undefined;
    const decoded: EnvironmentPairInput = {
      ...(input?.agents === false ? { agents: false } : {}),
      ...(input?.ssh !== undefined ? { ssh: environmentText("environments-pair", "ssh", input.ssh, 255) }
        : input?.wsl !== undefined ? { wsl: environmentText("environments-pair", "wsl", input.wsl, 100) }
          : input?.nearby !== undefined ? { nearby: environmentText("environments-pair", "nearby", input.nearby, 128) } : { text: environmentText("environments-pair", "text", input?.text, 16_384) }),
      ...(typeof input?.deviceName === "string" && input.deviceName.trim() ? { deviceName: input.deviceName.slice(0, 80) } : {}),
    }; return [decoded] as const; },
  }),
  "environments-set-preferences": command<void, [preferences: EnvironmentPreferences]>()({
    audit: { label: "changed machine preferences" },
    decode: (params) => { const input = params[0] as { reopenShown?: unknown } | undefined;
    if (typeof input?.reopenShown !== "boolean") throw failure("environments-set-preferences: reopenShown must be a boolean.");
    return [{ reopenShown: input.reopenShown }] as const; },
  }),
  "environments-set-agents": command<EnvironmentAgentsResult>()({
    audit: { label: "changed where this machine's agents may work" },
    decode: (params) => { if (typeof params[1] !== "boolean") throw failure("environments-set-agents: on must be a boolean."); return [environmentText("environments-set-agents", "id", params[0], 200), params[1]] as const; },
  }),
  "environments-watch-thread": command<UiEnvironmentThreadView | null>()({
    decode: (params) => { if (typeof params[2] !== "boolean") throw failure("environments-watch-thread: on must be a boolean."); return [environmentText("environments-watch-thread", "machine", params[0], 200), environmentText("environments-watch-thread", "sessionId", params[1], 512), params[2]] as const; },
  }),
  "environments-extension-follow": command<void>()({
    decode: (params) => { if (typeof params[2] !== "boolean") throw failure("environments-extension-follow: on must be a boolean."); return [environmentText("environments-extension-follow", "machine", params[0], 200), environmentText("environments-extension-follow", "extensionId", params[1], 200), params[2]] as const; },
  }),
  "environments-rename": command<{ renamed: boolean }>()({
    audit: { label: "renamed a machine" },
    decode: (params) => [environmentText("environments-rename", "id", params[0], 200), environmentText("environments-rename", "name", params[1], 80)] as const,
  }),
  "environments-remove": command<{ removed: boolean }>()({
    audit: { label: "removed a machine" },
    decode: (params) => [environmentText("environments-remove", "id", params[0], 200)] as const,
  }),
  "environments-retry": command<void>()({
    audit: { label: "reconnected a machine" },
    decode: (params) => [environmentText("environments-retry", "id", params[0], 200)] as const,
  }),
  "environments-config": command<ConfigLayers>()({
    decode: (params) => [environmentText("environments-config", "machine", params[0], 200)] as const,
  }),
  "environments-clear-config": command<TauConfig, [machine: string, keys: readonly string[]]>()({
    audit: { label: "reset another machine's settings" },
    decode: (params) => [environmentText("environments-clear-config", "machine", params[0], 200), decodeSettingKeys("environments-clear-config", "keys", params[1])] as const,
  }),
  "environments-transcript-page": command<TranscriptPage>()({
    decode: (params) => [environmentText("environments-transcript-page", "machine", params[0], 200), environmentText("environments-transcript-page", "sessionId", params[1], 512), decodeHostTranscriptCursor("environments-transcript-page", "cursor", params[2])] as const,
  }),
  "environments-extension-read": command<unknown>()({
    decode: (params) => [environmentText("environments-extension-read", "machine", params[0], 200), environmentText("environments-extension-read", "extensionId", params[1], 200), environmentText("environments-extension-read", "command", params[2], 200), params[3]] as const,
  }),
  "environments-open": command<void>()({
    audit: { label: "opened a machine" },
    decode: (params) => { const target = params[1] === undefined ? undefined : decodeEnvironmentOpenTarget(params[1]);
    return [environmentText("environments-open", "id", params[0], 200), target] as const; },
  }),
  "environments-update": command<HostUpdateStatus>()({
    audit: { label: "updated a machine's Tau" },
    decode: (params) => { const action = params[1]; const automatic = (action as { automatic?: unknown } | null)?.automatic;
    if (action !== "status" && action !== "check" && action !== "install" && typeof automatic !== "boolean") throw failure("environments-update: action must be status, check, install or { automatic }.");
    return [environmentText("environments-update", "machine", params[0], 200), typeof automatic === "boolean" ? { automatic } : action as "status" | "check" | "install"] as const; },
  }),
  "environments-set-person-preferences": command<PersonPreferences>()({
    audit: { label: "changed how the workbench looks", automatic: true, quiet: true },
    decode: (params) => { if (params[0] === null || typeof params[0] !== "object" || Array.isArray(params[0])) throw failure("environments-set-person-preferences: patch must be an object.");
    return [personPreferences(params[0])] as const; },
  }),
  "environments-update-config": command<TauConfig>()({
    audit: { label: "changed another machine's settings" },
    decode: (params) => { if (params[1] === null || typeof params[1] !== "object" || Array.isArray(params[1])) throw failure("environments-update-config: patch must be an object.");
    return [environmentText("environments-update-config", "machine", params[0], 200), params[1] as Record<string, unknown>] as const; },
  }),
  "environments-extension-invoke": command<unknown>()({
    audit: { label: "ran a command on another machine" },
    decode: (params) => { const options = params[4];
    if (options !== undefined && (options === null || typeof options !== "object" || Array.isArray(options) || ("timeoutMs" in options && (typeof options.timeoutMs !== "number" || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)))) throw failure("environments-extension-invoke: options must contain a positive timeoutMs.");
    return [environmentText("environments-extension-invoke", "machine", params[0], 200), environmentText("environments-extension-invoke", "extensionId", params[1], 200), environmentText("environments-extension-invoke", "command", params[2], 200), params[3], options as { timeoutMs?: number } | undefined] as const; },
  }),
});
