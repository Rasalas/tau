import type { RuntimeCompatibility, RuntimeInstanceConfig } from "tau";

/** The backend kind the default instance registers; threads carry it (or `codex@<instance>`) as `backendKind`. */
export const CODEX_BACKEND_KIND = "codex" as const;
export const CODEX_HOST_EXTENSION_ID = "tau.codex";
/** Usage Kit may read each thread's running total through the `usage` command. */
export const USAGE_KIT_ID = "tau.usage";
/** Search Kit indexes the text of threads nobody has open (`thread-texts`). */
export const SEARCH_KIT_ID = "tau.search";
/** Onboarding may list and import the sessions the CLI ran outside Tau. */
export const ONBOARDING_KIT_ID = "tau.onboarding";
export const CODEX_NPM_PACKAGE = "@openai/codex";
/**
 * The oldest CLI whose `app-server` protocol this kit speaks. The protocol is
 * marked experimental and moves between releases, so this is the release the
 * kit was built and tested against, not a guess at an older one.
 */
export const MIN_CODEX_VERSION = "0.154.0";

/** The variable an instance's home becomes. */
export const CODEX_HOME_VARIABLE = "CODEX_HOME";
/** Pushed with a `CodexInstancesReport` whenever an instance is added, changed or removed. */
export const INSTANCES_EVENT = "instances";

/** Pushed with a `ManagedCodexState` while Tau fetches its pinned Codex, and once more when it is done. */
export const MANAGED_CODEX_EVENT = "managed-codex";

/** Where fetching the Codex release Tau pins stands. */
export interface ManagedCodexState {
  version: string;
  phase: "downloading" | "extracting" | "installed" | "failed";
  downloadedBytes?: number;
  totalBytes?: number;
  error?: string;
}

/** A plan instance's account, for its card and the composer. */
export interface ChatGPTPlanSummary {
  instance?: string;
  signedIn: boolean;
  label: string;
  usageUrl: string;
  /** Tau's Codex is missing and no fetch runs. */
  needsInstall?: boolean;
}

/** One instance as the Providers page shows it. */
export interface CodexInstanceView extends RuntimeInstanceConfig {
  kind: string;
  label: string;
  /** Threads Tau keeps for it. */
  threads: number;
}

export interface CodexInstancesReport {
  instances: CodexInstanceView[];
}

/** What the `status` command reports to the Settings page, for one instance. */
export interface CodexStatusReport {
  instance?: string;
  command: string;
  /** Who chose `command`: the environment variable, or the path set on the card; absent for the PATH lookup. */
  commandSource?: "env" | "setting";
  path?: string;
  version?: string;
  latest?: string;
  updateCommand?: string;
  /** `latest` is newer than `version`. */
  updateAvailable?: boolean;
  /** The version policy calls it broken (below `MIN_CODEX_VERSION`, say): threads refuse to start. */
  unsupported?: boolean;
  /** The policy's verdict on `version`, with the release to install. */
  compatibility?: RuntimeCompatibility;
  /** The CLI's home, where its sessions and login live. */
  codexHome?: string;
  account?: { kind: "chatgpt" | "apiKey" | "other"; plan?: string; email?: string };
  signedIn?: boolean;
  models?: number;
  message?: string;
  chatgptPlan?: ChatGPTPlanSummary;
  /** Present while this instance waits for Tau's Codex, or after fetching it failed. */
  managedInstall?: ManagedCodexState;
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


/** Existing-thread account and tier choices, owned by the Codex kit. */
export interface CodexThreadSettings {
  account: string;
  accounts: Array<{ id: string; label: string; reason?: string }>;
  serviceTier: {
    selected: string | null;
    defaultTier: string | null;
    choices: Array<{ id: string; name: string; description?: string }>;
  };
}
