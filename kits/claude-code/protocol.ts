import type { RuntimeCompatibility, RuntimeInstanceConfig } from "tau";

/** Claude Code's contract between its host half and its desktop half. */
export const CLAUDE_CODE_HOST_EXTENSION_ID = "tau.claude-code";
/** The backend kind the default instance registers; threads carry it (or `claude-code@<instance>`) as `backendKind`. */
export const CLAUDE_CODE_BACKEND_KIND = "claude-code";
/** Usage Kit may read each thread's running total through the `usage` command. */
export const USAGE_KIT_ID = "tau.usage";
/** Search Kit indexes the text of threads nobody has open (`thread-texts`). */
export const SEARCH_KIT_ID = "tau.search";
/** Onboarding may list and import the sessions the CLI ran outside Tau. */
export const ONBOARDING_KIT_ID = "tau.onboarding";
/** The variable an instance's home becomes. */
export const CLAUDE_HOME_VARIABLE = "CLAUDE_CONFIG_DIR";
/** Pushed with a `ClaudeInstancesReport` whenever an instance is added, changed or removed. */
export const INSTANCES_EVENT = "instances";
/** Pushed when the user answers the CLI's resume question with "Don't ask again", for the desktop half to pass on. */
export const RESUME_QUESTION_OFF_EVENT = "resume-question-off";
/** Resume Compaction Kit's desktop service (`kits/resume-compaction/protocol.ts`), named here: a kit never imports another. */
export const RESUME_COMPACTION_OPT_OUT_SERVICE = "tau.resume-compaction/opt-out";

export interface ResumeQuestionOffEvent {
  /** The backend kind of the instance the thread runs on. */
  runtime: string;
}

/** One instance as the Providers page shows it. */
export interface ClaudeInstanceView extends RuntimeInstanceConfig {
  kind: string;
  label: string;
  /** Threads Tau keeps for it. */
  threads: number;
}

export interface ClaudeInstancesReport {
  instances: ClaudeInstanceView[];
}

/** What `status` reports for one instance. */
export interface ClaudeStatusReport {
  kind: string;
  instance?: string;
  command: string;
  path?: string;
  /** Who chose `command`: the environment variable or the card; absent for the PATH lookup. */
  commandSource?: "env" | "setting";
  update?: { installed: string; latest: string; command?: string };
  /** The version policy's verdict on the installed CLI. */
  compatibility?: RuntimeCompatibility;
  installed?: string;
  updateCommand?: string;
  /** From `auth status`; absent when the CLI cannot say. */
  signedIn?: boolean;
  /** Who it is signed in as, for Onboarding's line. */
  account?: string;
  /** The installed release, from `--version`. */
  version?: string;
}
