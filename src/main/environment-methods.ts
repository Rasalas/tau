import type { TauConfig } from "../shared/contracts.js";
import { HOST_FACTORY_COMMANDS } from "../shared/host-factory-commands.js";
import { bindHostCommand } from "./host-command-handler.js";
import type { UiDiscoveredHosts } from "../shared/discovery.js";
import {
  type EnvironmentAgentsResult,
  type EnvironmentOpenTarget,
  type EnvironmentPairInput,
  type EnvironmentPreferences,
  type EnvironmentPairResult,
  type EnvironmentTarget,
  type UiEnvironmentThreadView,
  type UiEnvironments,
} from "../shared/environments.js";
import type { TranscriptPage } from "../shared/host-protocol.js";
import { HOST_ERROR } from "../shared/host-transport.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import type { ConfigLayers } from "../shared/config-layers.js";
import type { HostMethodTable } from "./host-methods.js";
import type { HostUpdateAction, HostUpdateStatus } from "../shared/host-updates.js";
import type { PersonPreferences } from "../shared/person-preferences.js";

/** What the window's process answers about its machines (ADR 0025); `WindowEnvironments` is the one implementation. */
export interface EnvironmentsService {
  snapshot(): UiEnvironments;
  pair(input: EnvironmentPairInput): Promise<EnvironmentPairResult>;
  cancelPairing(): void;
  rename(id: string, name: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  retry(id: string): void;
  open(id: string, target?: EnvironmentOpenTarget): Promise<void>;
  takeArrival(): EnvironmentTarget | undefined;
  discover(): Promise<UiDiscoveredHosts>;
  listWsl?(): Promise<string[]>;
  setPreferences(preferences: EnvironmentPreferences): Promise<void>;
  setAgents(id: string, on: boolean): Promise<EnvironmentAgentsResult>;
  watchThread(machine: string, sessionId: string, on: boolean): UiEnvironmentThreadView | undefined;
  transcriptPage(machine: string, sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage>;
  invokeExtension(machine: string, extensionId: string, command: string, input?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  followExtension(machine: string, extensionId: string, on: boolean): void;
  readExtension(machine: string, extensionId: string, command: string, input?: unknown): Promise<unknown>;
  updateMachine(machine: string, action: HostUpdateAction): Promise<HostUpdateStatus>;
  personPreferences?(patch?: PersonPreferences): Promise<PersonPreferences>;
  configLayers(machine: string): Promise<ConfigLayers>;
  updateConfig(machine: string, patch: Record<string, unknown>): Promise<TauConfig>;
  clearConfig(machine: string, keys: readonly string[]): Promise<TauConfig>;
}

/**
 * The `environments-*` methods. A window answers them from its own process;
 * a host has no list of machines and refuses them all, so a page without a
 * window (a browser, a phone) simply has none.
 */
export function createEnvironmentMethods(service: () => EnvironmentsService | undefined): HostMethodTable {
  const require = (): EnvironmentsService => {
    const current = service();
    if (current) return current;
    throw Object.assign(new Error("Only a desktop window keeps a list of machines."), { code: HOST_ERROR.unsupported });
  };
  const ownMachine = (): EnvironmentsService & Required<Pick<EnvironmentsService, "personPreferences">> => {
    const current = require();
    if (current.personPreferences) return current as EnvironmentsService & Required<Pick<EnvironmentsService, "personPreferences">>;
    throw Object.assign(new Error("This window keeps no preferences of its own machine."), { code: HOST_ERROR.unsupported });
  };
  return {
    "environments-list": bindHostCommand(HOST_FACTORY_COMMANDS["environments-list"], async () => require().snapshot()),
    "environments-pair": bindHostCommand(HOST_FACTORY_COMMANDS["environments-pair"], async ([input]) => require().pair(input)),
    "environments-discover": bindHostCommand(HOST_FACTORY_COMMANDS["environments-discover"], async () => require().discover()),
    "environments-wsl-list": bindHostCommand(HOST_FACTORY_COMMANDS["environments-wsl-list"], async () => require().listWsl?.() ?? []),
    "environments-set-preferences": bindHostCommand(HOST_FACTORY_COMMANDS["environments-set-preferences"], async ([input]) => { await require().setPreferences(input); }),
    "environments-cancel-pairing": bindHostCommand(HOST_FACTORY_COMMANDS["environments-cancel-pairing"], async () => { require().cancelPairing(); }),
    "environments-set-agents": bindHostCommand(HOST_FACTORY_COMMANDS["environments-set-agents"], async (args) => require().setAgents(...args)),
    "environments-rename": bindHostCommand(HOST_FACTORY_COMMANDS["environments-rename"], async (args) => ({ renamed: await require().rename(...args) })),
    "environments-remove": bindHostCommand(HOST_FACTORY_COMMANDS["environments-remove"], async ([id]) => ({ removed: await require().remove(id) })),
    "environments-retry": bindHostCommand(HOST_FACTORY_COMMANDS["environments-retry"], async ([id]) => { require().retry(id); }),
    "environments-open": bindHostCommand(HOST_FACTORY_COMMANDS["environments-open"], async (args) => { await require().open(...args); }),
    "environments-take-arrival": bindHostCommand(HOST_FACTORY_COMMANDS["environments-take-arrival"], async () => require().takeArrival() ?? null),
    "environments-update": bindHostCommand(HOST_FACTORY_COMMANDS["environments-update"], async (args) => require().updateMachine(...args)),
    "environments-person-preferences": bindHostCommand(HOST_FACTORY_COMMANDS["environments-person-preferences"], async () => ownMachine().personPreferences()),
    "environments-set-person-preferences": bindHostCommand(HOST_FACTORY_COMMANDS["environments-set-person-preferences"], async ([patch]) => ownMachine().personPreferences(patch)),
    "environments-config": bindHostCommand(HOST_FACTORY_COMMANDS["environments-config"], async ([machine]) => require().configLayers(machine)),
    "environments-update-config": bindHostCommand(HOST_FACTORY_COMMANDS["environments-update-config"], async (args) => require().updateConfig(...args)),
    "environments-clear-config": bindHostCommand(HOST_FACTORY_COMMANDS["environments-clear-config"], async (args) => require().clearConfig(...args)),
    "environments-watch-thread": bindHostCommand(HOST_FACTORY_COMMANDS["environments-watch-thread"], async (args) => require().watchThread(...args) ?? null),
    "environments-transcript-page": bindHostCommand(HOST_FACTORY_COMMANDS["environments-transcript-page"], async (args) => require().transcriptPage(...args)),
    "environments-extension-follow": bindHostCommand(HOST_FACTORY_COMMANDS["environments-extension-follow"], async (args) => { require().followExtension(...args); }),
    "environments-extension-invoke": bindHostCommand(HOST_FACTORY_COMMANDS["environments-extension-invoke"], async (args) => require().invokeExtension(...args)),
    "environments-extension-read": bindHostCommand(HOST_FACTORY_COMMANDS["environments-extension-read"], async (args) => require().readExtension(...args)),
  };
}
