import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { GlobalHostEvent, HostExtensionSummary, UiRuntimeBackend } from "../shared/contracts.js";
import { HOST_SERVICE_PERMISSIONS } from "../shared/extension-permissions.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import {
  BIND_BROWSER_RESOURCES,
  CHECK_BROWSER_RESOURCE,
  REMOVE_BROWSER_RESOURCES,
  type HostBrowserResources,
} from "./host-browser-resources.js";
import { ExecutionPolicyRegistry } from "./host-execution-policy.js";
import type {
  HostClientCallOptions,
  HostCommandCall,
  HostExtension,
  HostExtensionCommandHandler,
  HostExtensionCommandOptions,
  HostExtensionContext,
  HostExtensionRegistryOptions,
  HostExtensionServices,
  HostExtensionSettings,
  HostMachineServices,
  HostNetworkServices,
  HostRuntimeBackendProvider,
  RuntimeExtensionContribution,
} from "./host-extension-contracts.js";
import { HostAuthorizationError, HostCommandError, hostErrorDiagnostic, isExpectedCommandError } from "./host-extension-errors.js";
import {
  HOST_CORE_PRINCIPAL,
  currentInvocationPrincipal,
  currentReadCwd,
  isHostOwner,
  runAsCaller,
  type AuditedCall,
  type HostInvocationPrincipal,
} from "./host-invocation.js";
import type { HostMachineRoutingContribution } from "./host-machine-routing.js";
import { ownerRefusal, readOnlyRefusal } from "./host-method-access.js";
import { BIND_NETWORK_EXTENSION } from "./host-network-contributions.js";
import { authorizeReadPaths } from "./host-read-paths.js";
import { TurnAttachmentRegistry } from "./turn-attachments.js";
export type * from "./host-extension-contracts.js";
/** Registered backends by `order`, unset last; equal orders keep registration order. */
export function sortByRuntimeOrder<T extends { readonly order?: number }>(providers: readonly T[]): T[] {
  const rank = (provider: T) => provider.order ?? Number.POSITIVE_INFINITY;
  return providers.map((provider, index) => ({ provider, index }))
    .sort((a, b) => rank(a.provider) - rank(b.provider) || a.index - b.index)
    .map(({ provider }) => provider);
}

/** What a backend declares of its marks, as its `runtimeBackends` entry carries it. */
export function runtimeBackendMarks(provider: Pick<HostRuntimeBackendProvider, "homeProviders" | "ownPlan">): Pick<UiRuntimeBackend, "homeProviders" | "ownPlan"> {
  return { ...(provider.homeProviders?.length ? { homeProviders: [...provider.homeProviders] } : {}), ...(provider.ownPlan ? { ownPlan: true } : {}) };
}

/** Binds `watch`'s default kit to the extension that asks; the registry calls it. */
export const BIND_MACHINES_EXTENSION = Symbol("bind-machines-extension");

/** Every mode the registered runtime extensions give Pi threads, once each. */
export function runtimeExtensionModes(contributions: readonly RuntimeExtensionContribution[]): string[] {
  return [...new Set(contributions.flatMap((contribution) => contribution.modes ?? []))].filter((mode) => mode !== "default");
}

/** What a command learns of the principal behind it; `extension` is the calling kit, resolved by the registry. */
export function commandCall(principal: HostInvocationPrincipal, extension?: string): HostCommandCall {
  if (principal.kind === "host-core") return { owner: true };
  if (principal.kind !== "workbench-client") {
    const caller = currentInvocationPrincipal();
    return { owner: false, ...(extension ? { extension } : {}), ...(caller?.kind !== "workbench-client" || !caller.readOnly ? { fullAccess: true as const } : {}) };
  }
  const owner = isHostOwner(principal);
  return { ...(principal.pairedClient ? { device: principal.pairedClient } : {}), owner, ...(!owner && !principal.readOnly ? { fullAccess: true as const } : {}) };
}

const MAX_TOPIC_LENGTH = 256;
const OFFER_CONTRACT = /^[a-z0-9][a-z0-9.-]{0,63}\/[a-z0-9][a-z0-9./-]{0,63}$/u;

export function guardedServices(
  services: HostExtensionServices,
  permissions?: readonly string[],
  extensionId: string = "unknown",
): HostExtensionServices {
  if (permissions === undefined) return services;
  const allowed = new Set(permissions);

  return new Proxy(services, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in HOST_SERVICE_PERMISSIONS) {
        const required = HOST_SERVICE_PERMISSIONS[prop];
        if (required && !allowed.has(required)) {
          const message = `Extension ${extensionId} lacks permission ${required}`;
          services.log("host-extension.denied", message);
          // A denied service is an authorization answer, not a broken command.
          // Keep it out of the registry's handler-crash counter; the denial is
          // already recorded above and the caller still receives the reason.
          throw new HostCommandError(message);
        }
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  });
}

/** What one extension sees: the permission guard, with `stateDir` bound to its own folder. */
const backendOwners = new WeakMap<HostRuntimeBackendProvider, string>();

/** The extension that registered a runtime backend; its `sign-in-state` speaks for the backend's program. */
export function runtimeBackendOwner(provider: HostRuntimeBackendProvider): string | undefined {
  return backendOwners.get(provider);
}

/**
 * The same services, reporting each release a call hands back (every
 * registration returns one), nested plain service objects such as `mcp` too.
 */
function reportReleases<T extends object>(services: T, report: (release: () => void) => void): T {
  const proxies = new WeakMap<object, object>();
  const functions = new WeakMap<object, WeakMap<Function, Function>>();
  const wrap = (value: unknown, owner: object): unknown => {
    if (typeof value === "function") {
      let byOwner = functions.get(owner);
      if (!byOwner) functions.set(owner, byOwner = new WeakMap());
      let wrapped = byOwner.get(value);
      if (!wrapped) {
        wrapped = (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, owner, args);
          if (typeof result === "function") report(result as () => void);
          return result;
        };
        byOwner.set(value, wrapped);
      }
      return wrapped;
    }
    return value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype ? proxy(value) : value;
  };
  const proxy = (target: object): object => {
    let found = proxies.get(target);
    if (!found) proxies.set(target, found = new Proxy(target, { get: (object, prop, receiver) => wrap(Reflect.get(object, prop, receiver), object) }));
    return found;
  };
  return proxy(services) as T;
}

export function extensionServices(services: HostExtensionServices, extension: Pick<HostExtension, "id" | "permissions">): HostExtensionServices {
  const guarded = guardedServices(services, extension.permissions, extension.id);
  const stateDir = services.stateDir ? join(services.stateDir, extension.id) : undefined;
  // `callClient` reaches one extension's own window half: the id is bound
  // here, never passed by the caller, so no kit can drive another kit's.
  const callClient = (command: string, input?: unknown, options?: HostClientCallOptions): Promise<unknown> =>
    (services.callClient as unknown as (id: string, command: string, input?: unknown, options?: HostClientCallOptions) => Promise<unknown>)(extension.id, command, input, options);
  const rawWindow = services.clientWindow as unknown as ((id: string) => string | undefined) | undefined;
  const clientWindow = rawWindow ? () => rawWindow(extension.id) : undefined;
  // Settings and attachments speak for the extension that asks, never for another.
  const rawSettings = services.settings as unknown as ((id: string, cwd?: string) => Promise<HostExtensionSettings>) | undefined;
  const settings = rawSettings ? (cwd?: string) => rawSettings(extension.id, cwd) : undefined;
  return new Proxy(guarded, {
    get: (target, prop, receiver) => {
      if (prop === "cwd") {
        const read = Reflect.get(target, prop, receiver) as HostExtensionServices["cwd"];
        return () => currentReadCwd() ?? read.call(receiver);
      }
      if (prop === "callClient") return callClient;
      if (prop === "clientWindow") return clientWindow;
      if (prop === "settings") return settings;
      if (prop === "turnAttachments") {
        const raw: unknown = Reflect.get(target, prop, receiver);
        return raw instanceof TurnAttachmentRegistry ? raw.forExtension(extension.id) : raw;
      }
      if (prop === "executionPolicy") {
        const raw: unknown = Reflect.get(target, prop, receiver);
        return raw instanceof ExecutionPolicyRegistry ? raw.forExtension(extension.id) : raw;
      }
      if (prop === "stateDir" && stateDir) return stateDir;
      if (prop === "machines") {
        const raw = Reflect.get(target, prop, receiver) as (HostMachineServices & { [BIND_MACHINES_EXTENSION]?: (id: string) => HostMachineServices }) | undefined;
        return raw?.[BIND_MACHINES_EXTENSION]?.(extension.id) ?? raw;
      }
      if (prop === "browserResources") {
        const raw = Reflect.get(target, prop, receiver) as (HostBrowserResources & { [BIND_BROWSER_RESOURCES]?: (id: string) => HostBrowserResources }) | undefined;
        return raw?.[BIND_BROWSER_RESOURCES]?.(extension.id) ?? raw;
      }
      if (prop === "network") {
        const raw = Reflect.get(target, prop, receiver) as (HostNetworkServices & { [BIND_NETWORK_EXTENSION]?: (id: string) => HostNetworkServices }) | undefined;
        return raw?.[BIND_NETWORK_EXTENSION]?.(extension.id) ?? raw;
      }
      if (prop === "registerRuntimeBackend") {
        const raw = Reflect.get(target, prop, receiver) as HostExtensionServices["registerRuntimeBackend"];
        return (provider: HostRuntimeBackendProvider) => {
          const unregister = raw(provider);
          backendOwners.set(provider, extension.id);
          return unregister;
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/u;
const EXTENSION_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;

const MAX_AUDIT_LABEL_LENGTH = 80;

function commandAudit(option: HostExtensionCommandOptions["audit"]): { label?: string; automatic?: true } | undefined {
  if (!option || typeof option !== "object") return undefined;
  const label = typeof option.label === "string" ? option.label.trim().slice(0, MAX_AUDIT_LABEL_LENGTH) : "";
  const audit = { ...(label ? { label } : {}), ...(option.automatic === true ? { automatic: true as const } : {}) };
  return Object.keys(audit).length ? audit : undefined;
}

/** A kit command's audit record; a `threadId` or `sessionId` in its input names the thread, nothing else of it is kept. */
function auditedCommandCall(record: ActiveHostExtension, action: string, command: string, input: unknown): AuditedCall {
  const declared = record.commandAudit.get(command);
  const fields = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const thread = typeof fields.threadId === "string" ? fields.threadId : typeof fields.sessionId === "string" ? fields.sessionId : "";
  return {
    action,
    label: declared?.label ?? `${record.extension.name}: ${command}`,
    ...(thread ? { threadId: thread } : {}),
    ...(declared?.automatic ? { automatic: true } : {}),
  };
}

interface ActiveHostExtension {
  extension: HostExtension;
  invocationContextId: string;
  commands: Map<string, HostExtensionCommandHandler>;
  longCommands: Set<string>;
  /** Commands registered with `access: "read"`. */
  readCommands: Set<string>;
  /** Commands registered with `access: "owner"`. */
  ownerCommands: Set<string>;
  /** Each command's `audit` option, when it has one. */
  commandAudit: Map<string, { label?: string; automatic?: true }>;
  commandCallers: Map<string, ReadonlySet<string>>;
  /** Contracts it said it answers (`offer`). */
  offers: Set<string>;
  disposers: Array<() => void | Promise<void>>;
  /** Set once the extension reported a failure it cannot recover from. */
  fatal?: string;
  /** When its activation finished. */
  startedAt?: number;
}

/** A crashed extension starts again on its next call; again after a crash soon after, only once this has passed, doubling. */
const RESTART_BACKOFF_MS = 10_000;
const RESTART_BACKOFF_MAX_MS = 5 * 60_000;
/** Stopped kit instances whose context is remembered for the denial log. */
const RETIRED_CONTEXTS_KEPT = 64;

export class HostExtensionRegistry {
  private readonly active = new Map<string, ActiveHostExtension>();
  private readonly machineRouting = new Map<string, HostMachineRoutingContribution>();
  private readonly machineRoutingObservers = new Set<() => void>();

  private readonly activationObservers = new Set<(id: string) => void>();

  /** Hears every extension that became active, once its commands answer; a reload is a new activation. */
  observeActivation(listener: (id: string) => void): () => void {
    this.activationObservers.add(listener);
    return () => { this.activationObservers.delete(listener); };
  }

  observeMachineRouting(listener: () => void): () => void {
    this.machineRoutingObservers.add(listener);
    return () => { this.machineRoutingObservers.delete(listener); };
  }

  machineRoutingFor(id: string): HostMachineRoutingContribution | undefined { return this.machineRouting.get(id); }
  private readonly known = new Map<string, HostExtension>();
  /** Host-issued contexts are valid only while their activation is alive. */
  private readonly invocationContexts = new Map<string, { extensionId: string; record?: ActiveHostExtension }>();
  /** In-process subscribers; the publishing id comes from its live activation. */
  private readonly eventObservers = new Map<string, Set<(payload: unknown) => void>>();
  /** Contexts of stopped kit instances, newest last: a leftover call they make is still refused, but names its kit. */
  private readonly retiredContexts = new Map<string, string>();
  private readonly failures = new Map<string, string>();
  private readonly consecutiveFailures = new Map<string, number>();
  /** Halves the list of turned-off extensions kept from running; `followChoices` starts them when it lets go. */
  private readonly heldOff = new Set<string>();
  /** Extensions that stopped on a failure while running, restarted by their next call. */
  private readonly crashed = new Map<string, { at: number; restarts: number }>();
  private readonly restarting = new Map<string, Promise<boolean>>();

  constructor(
    private readonly services: HostExtensionServices,
    private readonly publish: (event: GlobalHostEvent) => void,
    private readonly options: HostExtensionRegistryOptions = {},
  ) {}

  addKnown(extension: HostExtension): void {
    this.known.set(extension.id, extension);
  }

  /**
   * Activates one extension unless the user turned it off; a failure is
   * recorded and reported, never thrown.
   */
  async activate(extension: HostExtension): Promise<boolean> {
    this.crashed.delete(extension.id);
    if (this.options.disabled?.().includes(extension.id)) {
      await this.deactivate(extension.id);
      this.known.set(extension.id, extension);
      this.heldOff.add(extension.id);
      return false;
    }
    return this.start(extension);
  }

  private async start(extension: HostExtension): Promise<boolean> {
    if (!EXTENSION_ID.test(extension.id)) {
      this.failures.set(extension.id, `invalid host extension id "${extension.id}"`);
      return false;
    }
    await this.deactivate(extension.id);
    this.known.set(extension.id, extension);
    this.failures.delete(extension.id);
    this.clearCommandFailures(extension.id);
    const invocationContextId = randomUUID();
    const record: ActiveHostExtension = {
      extension,
      invocationContextId,
      commands: new Map(),
      longCommands: new Set(),
      readCommands: new Set(),
      ownerCommands: new Set(),
      commandAudit: new Map(),
      commandCallers: new Map(),
      offers: new Set(),
      disposers: [],
    };
    this.invocationContexts.set(invocationContextId, { extensionId: extension.id, record });
    // A failed activation leaves no MCP tool or observer behind: an agent would reach a kit that never started.
    const registrations: Array<() => void | Promise<void>> = [];
    let activating = true;
    const context: HostExtensionContext = {
      id: extension.id,
      invocationContextId,
      services: reportReleases(extensionServices(this.services, extension), (release) => { if (activating) registrations.push(release); }),
      invokeHostExtension: (extensionId, command, input) => this.invoke(
        extensionId,
        command,
        input,
        { kind: "host-extension", contextId: invocationContextId },
      ),
      registerMachineRouting: (policy = {}) => {
        if (!this.invocationContexts.has(invocationContextId)) throw new Error(`Host extension ${extension.id}: activation has ended`);
        if (policy.localCommands && !policy.localCommands.every((name) => typeof name === "string" && COMMAND_NAME.test(name))) throw new Error(`Host extension ${extension.id}: invalid local routing command`);
        if (this.machineRouting.has(extension.id)) throw new Error(`Host extension ${extension.id}: machine routing registered twice`);
        const listeners = new Set<() => void>();
        const contribution: HostMachineRoutingContribution = { policy, onDispose: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
        this.machineRouting.set(extension.id, contribution);
        const dispose = () => {
          if (this.machineRouting.get(extension.id) !== contribution) return;
          this.machineRouting.delete(extension.id);
          const errors: unknown[] = [];
          for (const listener of listeners) { try { listener(); } catch (error) { errors.push(error); } }
          listeners.clear();
          for (const observer of this.machineRoutingObservers) { try { observer(); } catch (error) { errors.push(error); } }
          if (errors.length) throw new AggregateError(errors, `Host extension ${extension.id}: machine routing cleanup failed`);
        };
        record.disposers.push(dispose);
        for (const observer of this.machineRoutingObservers) observer();
        return dispose;
      },
      registerCommand: (name, handler, options) => {
        if (!COMMAND_NAME.test(name)) throw new Error(`Host extension ${extension.id}: invalid command name "${name}"`);
        if (record.commands.has(name)) throw new Error(`Host extension ${extension.id}: command "${name}" registered twice`);
        const callers = options?.callers?.map((caller) => {
          if (!EXTENSION_ID.test(caller)) throw new Error(`Host extension ${extension.id}: invalid caller id "${caller}"`);
          return caller;
        }) ?? [];
        record.commands.set(name, handler);
        if (options?.long) record.longCommands.add(name);
        if (options?.access === "read") record.readCommands.add(name);
        if (options?.access === "owner") record.ownerCommands.add(name);
        const audit = commandAudit(options?.audit);
        if (audit) record.commandAudit.set(name, audit);
        record.commandCallers.set(name, new Set(callers));
        const dispose = () => {
          if (record.commands.get(name) !== handler) return;
          record.commands.delete(name);
          record.commandCallers.delete(name);
          record.longCommands.delete(name);
          record.readCommands.delete(name);
          record.ownerCommands.delete(name);
          record.commandAudit.delete(name);
        };
        record.disposers.push(dispose);
        return dispose;
      },
      observeExtensionEvent: (source, name, listener) => {
        if (!EXTENSION_ID.test(source) || !COMMAND_NAME.test(name)) throw new Error("Invalid extension event.");
        if (this.invocationContexts.get(invocationContextId)?.record !== record) throw new Error("Extension activation has ended.");
        const key = `${source}/${name}`;
        const guarded = (payload: unknown) => { if (this.active.get(extension.id) === record) listener(payload); };
        const observers = this.eventObservers.get(key) ?? new Set<(payload: unknown) => void>();
        observers.add(guarded); this.eventObservers.set(key, observers);
        const release = () => { observers.delete(guarded); if (!observers.size) this.eventObservers.delete(key); };
        record.disposers.push(release);
        return release;
      },
      emit: (name, payload, options) => {
        if (this.active.get(extension.id) !== record) return;
        const topic = options?.topic;
        if (topic !== undefined && !(typeof topic === "string" && topic.length > 0 && topic.length <= MAX_TOPIC_LENGTH)) {
          throw new Error(`Host extension ${extension.id}: a topic is a string of 1 to ${MAX_TOPIC_LENGTH} characters`);
        }
        for (const listener of this.eventObservers.get(`${extension.id}/${name}`) ?? []) {
          try { listener(payload); } catch { this.services.log("host-extension.event-observer-failed", extension.id); }
        }
        this.publish({ type: "extension-event", extensionId: extension.id, name, payload, ...(topic === undefined ? {} : { topic }) });
      },
      offer: (contract) => {
        if (!OFFER_CONTRACT.test(contract)) throw new Error(`Host extension ${extension.id}: a contract looks like "vendor.kit/name", not "${contract}"`);
        record.offers.add(contract);
        return () => { record.offers.delete(contract); };
      },
      offering: (contract) => this.offering(contract),
      fail: (reason) => this.reportFatal(extension, record, reason),
    };
    try {
      const dispose = await extension.activate(context);
      if (dispose) record.disposers.push(dispose);
      if (record.fatal) throw new Error(record.fatal);
      // From here the extension's own dispose releases them.
      activating = false;
      registrations.length = 0;
      record.startedAt = this.now();
      this.active.set(extension.id, record);
      this.services.log("host-extension.activated", `${extension.name} · ${[...record.commands.keys()].join(", ") || "no commands"}`);
      for (const observer of [...this.activationObservers]) {
        try { observer(extension.id); } catch (error) { this.services.log("host-extension.activation-observer-failed", error instanceof Error ? error.message : String(error)); }
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failures.set(extension.id, message);
      this.retireContext(invocationContextId);
      activating = false;
      await this.disposeAll(record.disposers).catch(() => undefined);
      await this.disposeAll(registrations).catch(() => undefined);
      this.services.log("host-extension.failed", `${extension.name}: ${message}`);
      this.services.log("host-extension.activation-failed", JSON.stringify({ extensionId: extension.id, error: hostErrorDiagnostic(error) }));
      return false;
    }
  }

  /** An extension that cannot go on: the reason is kept and the extension stops. */
  /** Active extensions that offered `contract`; a failed one has stopped answering. */
  offering(contract: string): Array<{ id: string; name: string }> {
    return [...this.active.values()]
      .filter((record) => !record.fatal && record.offers.has(contract))
      .map((record) => ({ id: record.extension.id, name: record.extension.name }));
  }

  private reportFatal(extension: HostExtension, record: ActiveHostExtension, reason: string): void {
    if (record.fatal) return;
    record.fatal = reason;
    this.failures.set(extension.id, reason);
    this.services.log("host-extension.failed", `${extension.name}: ${reason}`);
    if (this.active.get(extension.id) === record) {
      this.noteCrash(extension.id, record);
      this.announceDeactivation(extension, reason);
      void this.deactivate(extension.id).catch(() => undefined);
    }
  }

  /**
   * The one place a deactivation the user did not ask for is announced, so a
   * client can raise exactly one toast for it. A failure during `activate` is
   * not one of these: nothing was running yet, and `summaries()` carries it.
   */
  private announceDeactivation(extension: HostExtension, reason: string): void {
    this.publish({ type: "extension-deactivated", extensionId: extension.id, name: extension.name, reason });
  }

  /** Re-activates an extension the registry knows, after `deactivate`; one that runs keeps running. */
  async activateKnown(id: string): Promise<boolean> {
    const extension = this.known.get(id);
    if (!extension) throw new Error(`Host extension ${id} is not installed.`);
    this.heldOff.delete(id);
    this.crashed.delete(id);
    return this.active.has(id) ? true : this.start(extension);
  }

  /**
   * Applies the list of turned-off extensions as it reads now: a half on it
   * stops, one it held off starts. A half that was never started for another
   * reason (a package awaiting approval) is not one it held off, so it stays.
   */
  async followChoices(): Promise<void> {
    const disabled = new Set(this.options.disabled?.() ?? []);
    for (const id of [...this.active.keys()]) {
      if (!disabled.has(id)) continue;
      await this.deactivate(id);
      this.heldOff.add(id);
    }
    for (const id of [...this.heldOff]) {
      const extension = this.known.get(id);
      if (disabled.has(id) || !extension) continue;
      this.heldOff.delete(id);
      await this.start(extension);
    }
  }

  /** Forgets an extension entirely, e.g. when its package left the disk. */
  async remove(id: string): Promise<void> {
    this.heldOff.delete(id);
    this.crashed.delete(id);
    await this.deactivate(id);
    this.known.delete(id);
    this.failures.delete(id);
    this.clearCommandFailures(id);
  }

  /** Removes every per-command failure counter belonging to an extension. */
  private clearCommandFailures(extensionId: string): void {
    const prefix = `${extensionId}/`;
    for (const key of [...this.consecutiveFailures.keys()]) {
      if (key.startsWith(prefix)) this.consecutiveFailures.delete(key);
    }
  }

  private retireContext(contextId: string): void {
    const context = this.invocationContexts.get(contextId);
    this.invocationContexts.delete(contextId);
    if (!context) return;
    this.retiredContexts.set(contextId, context.extensionId);
    if (this.retiredContexts.size > RETIRED_CONTEXTS_KEPT) this.retiredContexts.delete(this.retiredContexts.keys().next().value!);
  }

  async deactivate(id: string): Promise<void> {
    const record = this.active.get(id);
    if (!record) return;
    this.active.delete(id);
    (this.services.browserResources as (HostBrowserResources & { [REMOVE_BROWSER_RESOURCES]?: (id: string) => void }) | undefined)?.[REMOVE_BROWSER_RESOURCES]?.(id);
    this.retireContext(record.invocationContextId);
    await this.disposeAll(record.disposers);
  }

  isActive(id: string): boolean {
    return this.active.has(id);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** A crash of a half that had run for a while starts the count of quick restarts afresh. */
  private noteCrash(id: string, record: ActiveHostExtension): void {
    const previous = this.crashed.get(id);
    const ranLong = record.startedAt !== undefined && this.now() - record.startedAt > RESTART_BACKOFF_MAX_MS;
    this.crashed.set(id, { at: this.now(), restarts: previous && !ranLong ? previous.restarts : 0 });
  }

  /**
   * Starts an extension that stopped on a failure while it ran (its worker
   * died, hit its memory cap, a command hung), when a call asks for it: the
   * first time at once, after a crash that follows a restart only once the
   * backoff has passed. One the user turned off, or that never started,
   * stays as it is.
   */
  private async restartCrashed(id: string): Promise<ActiveHostExtension | undefined> {
    const crash = this.crashed.get(id);
    const extension = this.known.get(id);
    if (!crash || !extension || this.heldOff.has(id) || this.options.disabled?.().includes(id)) return undefined;
    let pending = this.restarting.get(id);
    if (!pending) {
      const wait = crash.restarts === 0 ? 0 : Math.min(RESTART_BACKOFF_MAX_MS, RESTART_BACKOFF_MS * 2 ** (crash.restarts - 1));
      if (this.now() - crash.at < wait) return undefined;
      this.crashed.set(id, { at: this.now(), restarts: crash.restarts + 1 });
      this.services.log("host-extension.restarting", `${extension.name}: after "${this.failures.get(id) ?? "a failure"}"`);
      pending = this.start(extension).finally(() => this.restarting.delete(id));
      this.restarting.set(id, pending);
    }
    await pending;
    return this.active.get(id);
  }

  private async runWithTimeout<T>(fn: () => T | Promise<T>, timeoutMs: number, command: string): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new Error(`Command "${command}" timed out after ${timeoutMs}ms`));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new Error(`Command "${command}" timed out after ${timeoutMs}ms`));
      }, { once: true });
    });

    return Promise.race([
      Promise.resolve().then(() => fn()),
      timeoutPromise,
    ]);
  }

  async authorizeInvocation(extensionId: string, command: string, input: unknown, principal: HostInvocationPrincipal): Promise<void> {
    const record = await this.requireCommand(extensionId, command);
    this.authorize(record, extensionId, command, principal, input);
  }

  private async requireCommand(extensionId: string, command: string): Promise<ActiveHostExtension> {
    const record = this.active.get(extensionId) ?? await this.restartCrashed(extensionId);
    if (!record) {
      const known = this.known.get(extensionId);
      const failure = this.failures.get(extensionId);
      if (known) throw new Error(`Host extension ${known.name} is not active${failure ? `: ${failure}` : ""}.`);
      throw Object.assign(new HostCommandError(`Host extension ${extensionId} is not installed.`), { code: HOST_ERROR.unknownExtension });
    }
    if (!record.commands.has(command)) throw Object.assign(new HostCommandError(`Host extension ${record.extension.name} has no command "${command}".`), { code: HOST_ERROR.unknownCommand });
    return record;
  }

  async invoke(
    extensionId: string,
    command: string,
    input?: unknown,
    principal: HostInvocationPrincipal = HOST_CORE_PRINCIPAL,
  ): Promise<unknown> {
    const record = await this.requireCommand(extensionId, command);
    const handler = record.commands.get(command)!;
    this.authorize(record, extensionId, command, principal, input);
    const readCwd = await this.authorizeReadInput(record, extensionId, command, input, principal);

    const timeoutMs = this.options.commandTimeoutMs ?? 30_000;
    // The counter is keyed by command so that a healthy command cannot mask an
    // unstable sibling: three consecutive failures of *this* command deactivate
    // the extension, not three of any command.
    const commandKey = `${extensionId}/${command}`;
    try {
      const call = commandCall(principal, principal.kind === "host-extension" ? this.invocationContexts.get(principal.contextId)?.extensionId : undefined);
      const result = await runAsCaller(principal, async () => record.longCommands.has(command)
        ? await handler(input, call)
        : await this.runWithTimeout(() => handler(input, call), timeoutMs, command), readCwd);
      this.consecutiveFailures.delete(commandKey);
      return result;
    } catch (error) {
      // An answer to bad input is not a broken command: it neither counts
      // nor resets, so a real crash between two of them is still noticed.
      if (isExpectedCommandError(error)) throw error;
      const isTimeout = error instanceof Error && error.message.includes(`timed out after ${timeoutMs}ms`);
      const failures = (this.consecutiveFailures.get(commandKey) ?? 0) + 1;
      this.consecutiveFailures.set(commandKey, failures);
      this.services.log("host-extension.command-failed", JSON.stringify({
        extensionId, command, attempt: failures, error: hostErrorDiagnostic(error),
      }));

      if (isTimeout || failures >= 3) {
        // The reason names no extension: it is read beside the name, in a
        // summary row and in the client's toast.
        const reason = isTimeout
          ? `command "${command}" timed out after ${timeoutMs}ms. Check the host log for the last operation`
          : `failed three times in a row — ${error instanceof Error ? error.message : String(error)}`;
        this.failures.set(extensionId, reason);
        this.services.log("host-extension.failed", `${record.extension.name}: ${reason}`);
        this.announceDeactivation(record.extension, reason);
        this.noteCrash(extensionId, record);
        await this.deactivate(extensionId);
      }
      throw error;
    }
  }

  private async authorizeReadInput(record: ActiveHostExtension, extensionId: string, command: string, input: unknown, principal: HostInvocationPrincipal): Promise<string | undefined> {
    const client = principal.kind === "host-extension" ? currentInvocationPrincipal() : principal;
    if (!record.readCommands.has(command) || !client || client.kind !== "workbench-client" || !client.readOnly || isHostOwner(client)) return;
    try {
      const resources = this.services.browserResources as (HostBrowserResources & { [CHECK_BROWSER_RESOURCE]?: (path: string, extension: string, connection: string) => boolean }) | undefined;
      const fields = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
      const scope = [fields.workspace, fields.workspaceId, fields.cwd].find((value): value is string => typeof value === "string" && value.length > 0);
      let cwd: string;
      if (scope) {
        try { cwd = await this.services.knownWorkspacePath(scope); }
        catch { throw Object.assign(new HostCommandError("This device may read only admitted workspaces."), { code: "forbidden" }); }
      } else cwd = currentReadCwd() ?? this.services.cwd();
      await authorizeReadPaths(input, { cwd: () => cwd, knownWorkspacePath: (value) => this.services.knownWorkspacePath(value) }, (path) => Boolean(client.connection && resources?.[CHECK_BROWSER_RESOURCE]?.(path, extensionId, client.connection)));
      return cwd;
    } catch (error) {
      client.audit?.(auditedCommandCall(record, `${extensionId}/${command}`, command, input), false);
      throw error;
    }
  }

  /** Checks a host-issued caller before target lookup or handler execution. */
  private authorize(record: ActiveHostExtension, extensionId: string, command: string, principal: HostInvocationPrincipal, input?: unknown): void {
    if (principal.kind === "workbench-client") {
      // A client may call any command; a Read-only device only those that declared they just look.
      if (record.readCommands.has(command)) return;
      const action = `${extensionId}/${command}`;
      const call = auditedCommandCall(record, action, command, input);
      if (record.ownerCommands.has(command) && !isHostOwner(principal)) {
        principal.audit?.(call, false);
        throw ownerRefusal();
      }
      if (principal.readOnly) {
        principal.audit?.(call, false);
        throw readOnlyRefusal(`run ${action}`);
      }
      principal.audit?.(call, true);
      return;
    }
    if (principal.kind === "host-core") return;
    const context = principal.kind === "host-extension" ? this.invocationContexts.get(principal.contextId) : undefined;
    const caller = context?.extensionId;
    const allowed = caller === extensionId || Boolean(caller && record.commandCallers.get(command)?.has(caller));
    if (allowed) return;
    // Work a stopped instance left running (a restart after a timeout) still calls with its old context.
    const stopped = !context && principal.kind === "host-extension" ? this.retiredContexts.get(principal.contextId) : undefined;
    const reason = context
      ? "the host-issued context has no grant for this target command"
      : stopped ? "the calling extension instance was stopped" : "the host-issued context is unknown or expired";
    const details = {
      caller: caller ?? stopped ?? "unknown",
      target: extensionId,
      command,
      capability: `${extensionId}/${command}`,
      reason,
    } as const;
    this.services.log("host-extension.denied", JSON.stringify(details));
    throw new HostAuthorizationError(details);
  }

  /** Long commands of every active extension, as `<extensionId>/<command>`. */
  longCommands(): string[] {
    return [...this.active.values()].flatMap((record) => [...record.longCommands].map((command) => `${record.extension.id}/${command}`)).sort();
  }

  summaries(): HostExtensionSummary[] {
    return [...this.known.values()].map((extension) => {
      const record = this.active.get(extension.id);
      const error = this.failures.get(extension.id);
      return {
        id: extension.id,
        name: extension.name,
        active: Boolean(record),
        commands: record ? [...record.commands.keys()].sort() : [],
        ...(record?.readCommands.size ? { readCommands: [...record.readCommands].sort() } : {}),
        isolation: extension.isolation ?? "in-process",
        ...(error ? { error } : {}),
      };
    });
  }

  async dispose(): Promise<void> {
    const ids = [...this.active.keys()].reverse();
    const errors: unknown[] = [];
    for (const id of ids) {
      try { await this.deactivate(id); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Host extension shutdown failed");
  }

  private async disposeAll(disposers: Array<() => void | Promise<void>>): Promise<void> {
    const errors: unknown[] = [];
    for (const dispose of [...disposers].reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Host extension cleanup failed");
  }
}

export { HostProjectFactsSet, HostThreadLifecycleSet, HostTurnObserverSet } from "./host-extension-hooks.js";
