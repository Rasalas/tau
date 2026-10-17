import { command } from "../shared/host-command-definition.js";
import {
  decodeBoolean, decodeOptionalText, decodeText,
  decodeUiPromptAttachments, decodeUiSkillDraft,
} from "../shared/host-command-input.js";
import type { UiMessage } from "../shared/contracts.js";
import type { UiHostEndpoint, UiHostEndpointKind, UiNetworkAccess } from "../shared/connections.js";
import type { HostActionResult } from "../shared/host-protocol.js";
import type { WorkspaceRef } from "../shared/workspace-identity.js";
import type {
  DirectoryPickerOptions, HostExtensionSettings, HostImportedThread, HostSessionSummary,
  HostSkill, HostStartedThread, HostThreadImportOptions, HostThreadStartOptions, HostTrashedThread,
} from "./host-extensions.js";
import {
  CLIENT_HOOKS, CONFIG_HOOKS, FACT_HOOKS, LIFECYCLE_HOOKS, TURN_HOOKS,
  type WorkerPairedDevice, type WorkerSessionSnapshot, type WorkerThreadSnapshot,
} from "./host-extension-worker-protocol.js";
import { readUsageTally, type PricedUsage, type UsageTally } from "./usage-pricing.js";

/** Bind a declaration before erasing its arguments for transport dispatch. */
function serviceCommand<Result>() {
  return <const Name extends string, const Args extends readonly unknown[]>(
    name: Name,
    min: number,
    max: number,
    decode: (params: readonly unknown[]) => Args,
  ) => {
    const definition = command<Result>()({ decode: (params) => {
      if (!Array.isArray(params) || params.length < min || params.length > max) {
        throw new Error(`${name}: expected ${min === max ? min : `${min}-${max}`} arguments`);
      }
      return decode(params);
    } });
    return {
      ...definition,
      name,
      implement(handler: (args: NoInfer<Args>, requestId: number) => NoInfer<Result> | Promise<NoInfer<Result>>) {
        return { name, dispatch: async (params: readonly unknown[], requestId: number): Promise<Result> => handler(definition.decode(params), requestId) };
      },
    };
  };
}

function record(method: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${method}: expected an object`);
  return value as Record<string, unknown>;
}
function strings(method: string, value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string")) throw new Error(`${method}: expected strings`);
  return value;
}
function choice<const Values extends readonly string[]>(method: string, value: unknown, values: Values): Values[number] {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`${method}: expected one of ${values.join(", ")}`);
  return found;
}
function hooks(method: string, value: unknown, allowed: readonly string[]): string[] {
  const names = strings(method, value);
  if (names.some((name) => !allowed.includes(name))) throw new Error(`${method}: unknown hook`);
  return names;
}
const text = (method: string, value: unknown): string => decodeText(method, "argument", value);
const optionalText = (method: string, value: unknown): string | undefined => decodeOptionalText(method, "argument", value);
const noArgs = () => [] as const;

function picker(value: unknown): DirectoryPickerOptions | undefined {
  if (value === undefined) return undefined;
  const item = record("pickDirectory", value);
  return {
    ...(item.buttonLabel === undefined ? {} : { buttonLabel: text("pickDirectory.buttonLabel", item.buttonLabel) }),
    ...(item.message === undefined ? {} : { message: text("pickDirectory.message", item.message) }),
    ...(item.createDirectory === undefined ? {} : { createDirectory: decodeBoolean("pickDirectory", "createDirectory", item.createDirectory) }),
  };
}
function start(value: unknown): Omit<HostThreadStartOptions, "beforePrompt"> {
  const method = "sessions.start";
  const item = record(method, value);
  if (item.beforePrompt !== undefined) throw new Error(`${method}: beforePrompt is in-process only`);
  const model = item.model === undefined ? undefined : record(method, item.model);
  const parent = item.parent === undefined ? undefined : record(method, item.parent);
  return {
    cwd: text(method, item.cwd), prompt: text(method, item.prompt),
    ...(item.attachments === undefined ? {} : { attachments: decodeUiPromptAttachments(method, "attachments", item.attachments) }),
    ...(item.skillDraft === undefined ? {} : { skillDraft: decodeUiSkillDraft(method, "skillDraft", item.skillDraft) }),
    ...(item.thinkingLevel === undefined ? {} : { thinkingLevel: text(method, item.thinkingLevel) }),
    ...(item.mode === undefined ? {} : { mode: text(method, item.mode) }),
    ...(item.title === undefined ? {} : { title: text(method, item.title) }),
    ...(item.backend === undefined ? {} : { backend: text(method, item.backend) }),
    ...(item.tools === undefined ? {} : { tools: strings(method, item.tools) }),
    ...(model ? { model: { provider: text(method, model.provider), id: text(method, model.id) } } : {}),
    ...(parent ? { parent: {
      threadId: text(method, parent.threadId),
      ...(parent.details === undefined ? {} : { details: record(method, parent.details) }),
    } } : {}),
  };
}
function importSession(value: unknown): HostThreadImportOptions {
  const method = "sessions.import";
  const item = record(method, value);
  const origin = record(method, item.origin);
  return {
    cwd: text(method, item.cwd), jsonl: text(method, item.jsonl),
    ...(item.title === undefined ? {} : { title: text(method, item.title) }),
    origin: {
      hostId: text(method, origin.hostId), threadId: text(method, origin.threadId),
      ...(origin.details === undefined ? {} : { details: record(method, origin.details) }),
    },
  };
}
function tallies(value: unknown): readonly UsageTally[] {
  if (!Array.isArray(value)) throw new Error("priceUsage: expected tallies");
  return value.map((item) => {
    const raw = record("priceUsage", item);
    for (const field of ["provider", "model"] as const) {
      if (raw[field] !== undefined) text("priceUsage", raw[field]);
    }
    if (raw.billing !== undefined) choice("priceUsage", raw.billing, ["subscription", "api-key", "free", "local"]);
    const tally = readUsageTally(item);
    if (!tally) throw new Error("priceUsage: invalid tally");
    return tally;
  });
}
function endpoints(value: unknown): readonly UiHostEndpoint[] {
  const method = "network.publishEndpoints";
  if (!Array.isArray(value)) throw new Error(`${method}: expected endpoints`);
  return value.map((endpoint) => {
    const item = record(method, endpoint);
    const kind: UiHostEndpointKind | undefined = item.kind === undefined ? undefined : choice(method, item.kind, ["loopback", "lan", "mdns", "tailscale", "magicdns"]);
    return {
      url: text(method, item.url), label: text(method, item.label),
      reachability: choice(method, item.reachability, ["loopback", "network"]),
      ...(kind === undefined ? {} : { kind }),
      ...(item.interface === undefined ? {} : { interface: text(method, item.interface) }),
      ...(item.ipv6 === undefined ? {} : { ipv6: decodeBoolean(method, "ipv6", item.ipv6) }),
      ...(item.trustedCertificate === undefined ? {} : { trustedCertificate: decodeBoolean(method, "trustedCertificate", item.trustedCertificate) }),
    };
  });
}
function pins(value: unknown): Record<string, string[]> {
  return Object.fromEntries(Object.entries(record("pinTranscriptEntries", value)).map(([sessionId, entries]) => [sessionId, strings("pinTranscriptEntries", entries)]));
}
function pendingCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("setPendingWork: count must be a finite number");
  return value;
}

/** Every worker service round trip, including context calls and the lock handshake. */
export const WORKER_SERVICE_COMMANDS = {
  cwd: serviceCommand<string>()("cwd", 0, 0, noArgs),
  openWorkspace: serviceCommand<HostActionResult>()("openWorkspace", 1, 1, (p) => [text("openWorkspace", p[0])] as const),
  knownWorkspacePath: serviceCommand<string>()("knownWorkspacePath", 1, 1, (p) => [text("knownWorkspacePath", p[0])] as const),
  workspaceRef: serviceCommand<WorkspaceRef>()("workspaceRef", 1, 1, (p) => [text("workspaceRef", p[0])] as const),
  admitWorkspace: serviceCommand<WorkspaceRef>()("admitWorkspace", 1, 1, (p) => [text("admitWorkspace", p[0])] as const),
  projectName: serviceCommand<string>()("projectName", 1, 1, (p) => [text("projectName", p[0])] as const),
  settings: serviceCommand<HostExtensionSettings>()("settings", 0, 1, (p) => [optionalText("settings", p[0])] as const),
  priceUsage: serviceCommand<PricedUsage[]>()("priceUsage", 1, 1, (p) => [tallies(p[0])] as const),
  rememberProjectName: serviceCommand<void>()("rememberProjectName", 2, 2, (p) => [text("rememberProjectName", p[0]), text("rememberProjectName", p[1])] as const),
  pickDirectory: serviceCommand<string | undefined>()("pickDirectory", 0, 1, (p) => [picker(p[0])] as const),
  runtimeOwner: serviceCommand<"tau" | "pi">()("runtimeOwner", 0, 0, noArgs),
  thread: serviceCommand<WorkerThreadSnapshot | undefined>()("thread", 0, 1, (p) => [optionalText("thread", p[0])] as const),
  transcript: serviceCommand<UiMessage[]>()("transcript", 0, 1, (p) => [optionalText("transcript", p[0])] as const),
  setThreadTitle: serviceCommand<void>()("setThreadTitle", 3, 3, (p) => [text("setThreadTitle", p[0]), text("setThreadTitle", p[1]), choice("setThreadTitle", p[2], ["generated", "renamed"])] as const),
  noteSubprocess: serviceCommand<void>()("noteSubprocess", 0, 0, noArgs),
  findCommand: serviceCommand<string | undefined>()("findCommand", 1, 1, (p) => [text("findCommand", p[0])] as const),
  skills: serviceCommand<HostSkill[]>()("skills", 1, 1, (p) => [text("skills", p[0])] as const),
  refreshExtensionPackages: serviceCommand<void>()("refreshExtensionPackages", 0, 0, noArgs),
  describeProjects: serviceCommand<number>()("describeProjects", 1, 1, (p) => [hooks("describeProjects", p[0], FACT_HOOKS)] as const),
  "sessions.list": serviceCommand<HostSessionSummary[]>()("sessions.list", 0, 0, noArgs),
  "sessions.read": serviceCommand<WorkerSessionSnapshot>()("sessions.read", 1, 1, (p) => [text("sessions.read", p[0])] as const),
  "sessions.start": serviceCommand<HostStartedThread>()("sessions.start", 1, 1, (p) => [start(p[0])] as const),
  "sessions.import": serviceCommand<HostImportedThread>()("sessions.import", 1, 1, (p) => [importSession(p[0])] as const),
  "sessions.remove": serviceCommand<void>()("sessions.remove", 1, 1, (p) => [text("sessions.remove", p[0])] as const),
  "sessions.restore": serviceCommand<void>()("sessions.restore", 1, 1, (p) => [text("sessions.restore", p[0])] as const),
  "sessions.trash": serviceCommand<HostTrashedThread[]>()("sessions.trash", 0, 0, noArgs),
  "sessions.purge": serviceCommand<void>()("sessions.purge", 1, 1, (p) => [text("sessions.purge", p[0])] as const),
  // The result is the worker's own callback value, serialized through exit/res.
  "sessions.exclusive": serviceCommand<unknown>()("sessions.exclusive", 0, 0, noArgs),
  "clients.count": serviceCommand<number>()("clients.count", 0, 0, noArgs),
  "clients.devices": serviceCommand<WorkerPairedDevice[]>()("clients.devices", 0, 0, noArgs),
  "clients.observe": serviceCommand<number>()("clients.observe", 1, 1, (p) => [hooks("clients.observe", p[0], CLIENT_HOOKS)] as const),
  "network.state": serviceCommand<UiNetworkAccess | undefined>()("network.state", 0, 0, noArgs),
  "network.holdProxy": serviceCommand<number>()("network.holdProxy", 0, 0, noArgs),
  "network.keepProxy": serviceCommand<void>()("network.keepProxy", 1, 1, (p) => [decodeBoolean("network.keepProxy", "keep", p[0])] as const),
  "network.publishEndpoints": serviceCommand<number>()("network.publishEndpoints", 1, 1, (p) => [endpoints(p[0])] as const),
  observeConfigChanges: serviceCommand<number>()("observeConfigChanges", 1, 1, (p) => [hooks("observeConfigChanges", p[0], CONFIG_HOOKS)] as const),
  registerThreadLifecycle: serviceCommand<number>()("registerThreadLifecycle", 1, 1, (p) => [hooks("registerThreadLifecycle", p[0], LIFECYCLE_HOOKS)] as const),
  registerTurnObserver: serviceCommand<number>()("registerTurnObserver", 1, 1, (p) => [hooks("registerTurnObserver", p[0], TURN_HOOKS)] as const),
  setPendingWork: serviceCommand<void>()("setPendingWork", 2, 2, (p) => [text("setPendingWork", p[0]), pendingCount(p[1])] as const),
  pinTranscriptEntries: serviceCommand<number>()("pinTranscriptEntries", 1, 1, (p) => [pins(p[0])] as const),
  offering: serviceCommand<Array<{ id: string; name: string }>>()("offering", 1, 1, (p) => [text("offering", p[0])] as const),
  hostExtension: serviceCommand<unknown>()("hostExtension", 2, 3, (p) => [text("hostExtension", p[0]), text("hostExtension", p[1]), p[2]] as const),
};

export type WorkerServiceName = keyof typeof WORKER_SERVICE_COMMANDS;
type Declaration = typeof WORKER_SERVICE_COMMANDS[WorkerServiceName];
type OptionalTail<Args extends readonly unknown[]> = Args extends readonly [...infer Before, infer Last]
  ? undefined extends Last ? [...OptionalTail<Before>, Last?] : [...Args]
  : [];
export type WorkerServiceArgs<C extends Declaration> = OptionalTail<ReturnType<C["decode"]>>;
// The bound dispatch retains undefined results that an optional type witness can lose.
export type WorkerServiceResult<C extends Declaration> = Awaited<ReturnType<ReturnType<C["implement"]>["dispatch"]>>;
export type WorkerServiceDispatch = {
  [Name in WorkerServiceName]: {
    name: Name;
    dispatch(args: readonly unknown[], requestId: number): Promise<WorkerServiceResult<typeof WORKER_SERVICE_COMMANDS[Name]>>;
  };
};

/** The one result trust assertion: the port pairs a response with its request id. */
export function createWorkerServiceCaller(transport: (path: string, args: readonly unknown[]) => Promise<unknown>) {
  return <C extends Declaration>(definition: C, ...args: WorkerServiceArgs<NoInfer<C>>): Promise<WorkerServiceResult<C>> =>
    transport(definition.name, args) as Promise<WorkerServiceResult<C>>;
}

function isServiceName(path: string): path is WorkerServiceName {
  return Object.hasOwn(WORKER_SERVICE_COMMANDS, path);
}
export function dispatchWorkerService(dispatch: WorkerServiceDispatch, path: string, args: readonly unknown[], requestId: number, extensionName: string): Promise<unknown> {
  if (!isServiceName(path)) throw new Error(`Host extension ${extensionName} asked for an unknown host service "${path}".`);
  return dispatch[path].dispatch(args, requestId);
}
