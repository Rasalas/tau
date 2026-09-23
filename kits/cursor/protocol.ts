import type { RuntimeCompatibility, RuntimeInstanceConfig } from "tau";

/** The backend kind the default instance registers; another instance is `cursor@<id>`. */
export const CURSOR_BACKEND_KIND = "cursor" as const;
export const CURSOR_HOST_EXTENSION_ID = "tau.cursor";
/** Usage Kit may read each thread's running total through the `usage` command. */
export const USAGE_KIT_ID = "tau.usage";
/** Older CLIs lack `agent acp` with the parameterized model picker Tau asks for. */
export const MIN_CURSOR_VERSION = "2026.04.08";

/**
 * An instance's home: the Cursor CLI keeps its config, chats and (with a
 * home) its login there instead of in `~/.cursor` and the keychain.
 */
export const CURSOR_HOME_VARIABLE = "TAU_CURSOR_HOME";
/** Pushed with a `CursorInstancesReport` whenever an instance is added, changed or removed. */
export const INSTANCES_EVENT = "instances";

/** One instance as the Providers page shows it. */
export interface CursorInstanceView extends RuntimeInstanceConfig {
  kind: string;
  label: string;
  /** Threads Tau keeps for it. */
  threads: number;
}

export interface CursorInstancesReport {
  instances: CursorInstanceView[];
}

/** What the `status` command reports to the Settings page, for one instance. */
export interface CursorStatusReport {
  instance?: string;
  command: string;
  /** Who chose `command`: the environment variable, or the path set on the card; absent for the PATH lookup. */
  commandSource?: "env" | "setting";
  path?: string;
  version?: string;
  latest?: string;
  updateCommand?: string;
  updateAvailable?: boolean;
  unsupported?: boolean;
  compatibility?: RuntimeCompatibility;
  /** Who the CLI is signed in as, from `about`; absent when it could not tell. */
  account?: string;
  /** The Cursor plan, from `about`: `Pro`, `Team` … */
  plan?: string;
  signedIn?: boolean;
  models?: number;
  message?: string;
}
