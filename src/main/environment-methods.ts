import type { UiDiscoveredHosts } from "../shared/discovery.js";
import {
  decodeEnvironmentOpenTarget,
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
import { decodeHostTranscriptCursor } from "./ipc-input.js";
import type { HostMethodTable } from "./host-methods.js";
import type { HostUpdateAction, HostUpdateStatus } from "../shared/host-updates.js";

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
  invokeExtension(machine: string, extensionId: string, command: string, input?: unknown): Promise<unknown>;
  readExtension(machine: string, extensionId: string, command: string, input?: unknown): Promise<unknown>;
  updateMachine(machine: string, action: HostUpdateAction): Promise<HostUpdateStatus>;
}

function text(method: string, name: string, value: unknown, max = 4_096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw Object.assign(new Error(`${method}: ${name} must be a non-empty string of at most ${max} characters.`), { code: HOST_ERROR.invalidRequest });
  }
  return value;
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
  return {
    "environments-list": async () => require().snapshot(),
    "environments-pair": async (params) => {
      const input = params[0] as { text?: unknown; nearby?: unknown; ssh?: unknown; wsl?: unknown; deviceName?: unknown; agents?: unknown } | undefined;
      return require().pair({
        ...(input?.agents === false ? { agents: false } : {}),
        ...(input?.ssh !== undefined ? { ssh: text("environments-pair", "ssh", input.ssh, 255) }
          : input?.wsl !== undefined ? { wsl: text("environments-pair", "wsl", input.wsl, 100) }
            : input?.nearby !== undefined ? { nearby: text("environments-pair", "nearby", input.nearby, 128) } : { text: text("environments-pair", "text", input?.text, 16_384) }),
        ...(typeof input?.deviceName === "string" && input.deviceName.trim() ? { deviceName: input.deviceName.slice(0, 80) } : {}),
      });
    },
    "environments-discover": async () => require().discover(),
    "environments-wsl-list": async () => require().listWsl?.() ?? [],
    "environments-set-preferences": async (params) => {
      const input = params[0] as { reopenShown?: unknown } | undefined;
      if (typeof input?.reopenShown !== "boolean") {
        throw Object.assign(new Error("environments-set-preferences: reopenShown must be a boolean."), { code: HOST_ERROR.invalidRequest });
      }
      await require().setPreferences({ reopenShown: input.reopenShown });
    },
    "environments-cancel-pairing": async () => { require().cancelPairing(); },
    "environments-set-agents": async (params) => {
      if (typeof params[1] !== "boolean") {
        throw Object.assign(new Error("environments-set-agents: on must be a boolean."), { code: HOST_ERROR.invalidRequest });
      }
      return require().setAgents(text("environments-set-agents", "id", params[0], 200), params[1]);
    },
    "environments-rename": async (params) => ({
      renamed: await require().rename(text("environments-rename", "id", params[0], 200), text("environments-rename", "name", params[1], 80)),
    }),
    "environments-remove": async (params) => ({ removed: await require().remove(text("environments-remove", "id", params[0], 200)) }),
    "environments-retry": async (params) => { require().retry(text("environments-retry", "id", params[0], 200)); },
    "environments-open": async (params) => {
      const target = params[1] === undefined ? undefined : decodeEnvironmentOpenTarget(params[1]);
      await require().open(text("environments-open", "id", params[0], 200), target);
    },
    "environments-take-arrival": async () => require().takeArrival() ?? null,
    // A machine's own Tau over the window's connection there (K103).
    "environments-update": async (params) => {
      const action = params[1];
      const automatic = (action as { automatic?: unknown } | null)?.automatic;
      if (action !== "status" && action !== "check" && action !== "install" && typeof automatic !== "boolean") {
        throw Object.assign(new Error("environments-update: action must be status, check, install or { automatic }."), { code: HOST_ERROR.invalidRequest });
      }
      return require().updateMachine(text("environments-update", "machine", params[0], 200), typeof automatic === "boolean" ? { automatic } : action as "status" | "check" | "install");
    },
    "environments-watch-thread": async (params) => {
      if (typeof params[2] !== "boolean") {
        throw Object.assign(new Error("environments-watch-thread: on must be a boolean."), { code: HOST_ERROR.invalidRequest });
      }
      return require().watchThread(
        text("environments-watch-thread", "machine", params[0], 200),
        text("environments-watch-thread", "sessionId", params[1], 512),
        params[2],
      ) ?? null;
    },
    "environments-transcript-page": async (params) => require().transcriptPage(
      text("environments-transcript-page", "machine", params[0], 200),
      text("environments-transcript-page", "sessionId", params[1], 512),
      decodeHostTranscriptCursor("environments-transcript-page", "cursor", params[2]),
    ),
    "environments-extension-invoke": async (params) => require().invokeExtension(
      text("environments-extension-invoke", "machine", params[0], 200),
      text("environments-extension-invoke", "extensionId", params[1], 200),
      text("environments-extension-invoke", "command", params[2], 200),
      params[3],
    ),
    "environments-extension-read": async (params) => require().readExtension(
      text("environments-extension-read", "machine", params[0], 200),
      text("environments-extension-read", "extensionId", params[1], 200),
      text("environments-extension-read", "command", params[2], 200),
      params[3],
    ),
  };
}
