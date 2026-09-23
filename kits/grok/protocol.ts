import type { RuntimeCompatibility, RuntimeInstanceConfig } from "tau";

/** The backend kind the default instance registers; another instance is `grok@<id>`. */
export const GROK_BACKEND_KIND = "grok" as const;
export const GROK_HOST_EXTENSION_ID = "tau.grok";
/** Usage Kit may read each thread's usage and the plan's limits. */
export const USAGE_KIT_ID = "tau.usage";
/** Search Kit indexes the text of threads nobody has open (`thread-texts`). */
export const SEARCH_KIT_ID = "tau.search";

/**
 * An instance's home: the Grok CLI keeps its config, login (`auth.json`) and
 * sessions there (`GROK_HOME`) instead of in `~/.grok`.
 */
export const GROK_HOME_VARIABLE = "TAU_GROK_HOME";
/** Pushed with a `GrokInstancesReport` whenever an instance is added, changed or removed. */
export const INSTANCES_EVENT = "instances";

/** One instance as the Providers page shows it. */
export interface GrokInstanceView extends RuntimeInstanceConfig {
  kind: string;
  label: string;
  /** Threads Tau keeps for it. */
  threads: number;
}

export interface GrokInstancesReport {
  instances: GrokInstanceView[];
}

/** What the `status` command reports to the Settings page, for one instance. */
export interface GrokStatusReport {
  instance?: string;
  command: string;
  /** Who chose `command`: the environment variable, or the path set on the card; absent for the PATH lookup. */
  commandSource?: "env" | "setting";
  path?: string;
  version?: string;
  compatibility?: RuntimeCompatibility;
  /** How the CLI signs in: its own login, or an xAI API key from the environment. */
  login?: "account" | "api-key";
  /** What `grok models` names the login: `grok.com`. */
  account?: string;
  signedIn?: boolean;
  models?: number;
  message?: string;
}
