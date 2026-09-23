import type { RuntimeCompatibility, RuntimeInstanceConfig } from "tau";

/** The backend kind the default instance registers; another instance is `opencode@<id>`. */
export const OPENCODE_BACKEND_KIND = "opencode" as const;
export const OPENCODE_HOST_EXTENSION_ID = "tau.opencode";
/** Usage Kit may read each thread's running total through the `usage` command. */
export const USAGE_KIT_ID = "tau.usage";
/** Search Kit indexes the text of threads nobody has open (`thread-texts`). */
export const SEARCH_KIT_ID = "tau.search";
/** Onboarding may list and import the sessions OpenCode ran outside Tau. */
export const ONBOARDING_KIT_ID = "tau.onboarding";
export const OPENCODE_NPM_PACKAGE = "opencode-ai";
/** The release this kit was built and tested against. */
export const TESTED_OPENCODE_VERSION = "1.18.32";
/** Older servers lack the permission, question and health routes Tau speaks. */
export const MIN_OPENCODE_VERSION = "1.14.19";

/**
 * An instance's home: OpenCode keeps config, data, state and cache under the
 * XDG folders, so a home becomes all four (`<home>/config`, …) for its process.
 */
export const OPENCODE_HOME_VARIABLE = "TAU_OPENCODE_HOME";
/** Pushed with an `OpenCodeInstancesReport` whenever an instance is added, changed or removed. */
export const INSTANCES_EVENT = "instances";

/** One instance as the Providers page shows it. */
export interface OpenCodeInstanceView extends RuntimeInstanceConfig {
  kind: string;
  label: string;
  /** Threads Tau keeps for it. */
  threads: number;
  /** An OpenCode server the instance connects to instead of starting one. */
  serverUrl?: string;
  /** A password is saved for that server; the password itself never leaves the host. */
  hasPassword?: boolean;
}

export interface OpenCodeInstancesReport {
  instances: OpenCodeInstanceView[];
}

/** A provider OpenCode can reach, as the card lists it. */
export interface OpenCodeProviderSummary {
  id: string;
  name: string;
  models: number;
}

/** What the `status` command reports to the Settings page, for one instance. */
export interface OpenCodeStatusReport {
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
  /** The server the instance connects to; absent when Tau starts its own. */
  serverUrl?: string;
  /** Providers with a login or key, so a thread can use their models. */
  providers?: OpenCodeProviderSummary[];
  /** The providers in a few words, for a line that names who a runtime is signed in as. */
  account?: string;
  signedIn?: boolean;
  models?: number;
  message?: string;
}

/**
 * Questionnaire Kit pages through prompts that carry this extra; its shape is
 * `UiQuestionnaire` in `kits/questionnaire/protocol.ts`.
 */
export const QUESTIONNAIRE_EXTRA = "tau.questionnaire";

export interface QuestionnaireQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description: string }>;
}

export function tagQuestionnaire(prompt: { extras?: Record<string, unknown> }, index: number, questions: readonly QuestionnaireQuestion[]): void {
  prompt.extras = { ...prompt.extras, [QUESTIONNAIRE_EXTRA]: { index, questions } };
}
