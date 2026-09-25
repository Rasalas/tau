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
  setPreferences(preferences: EnvironmentPreferences): Promise<void>;
  setAgents(id: string, on: boolean): Promise<EnvironmentAgentsResult>;
  watchThread(machine: string, sessionId: string, on: boolean): UiEnvironmentThreadView | undefined;
  transcriptPage(machine: string, sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage>;
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
      const input = params[0] as { text?: unknown; nearby?: unknown; deviceName?: unknown; agents?: unknown } | undefined;
      return require().pair({
        ...(input?.agents === false ? { agents: false } : {}),
        ...(input?.nearby !== undefined ? { nearby: text("environments-pair", "nearby", input.nearby, 128) } : { text: text("environments-pair", "text", input?.text) }),
        ...(typeof input?.deviceName === "string" && input.deviceName.trim() ? { deviceName: input.deviceName.slice(0, 80) } : {}),
      });
    },
    "environments-discover": async () => require().discover(),
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
  };
}
