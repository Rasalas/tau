/** The backend kind the host entry registers; threads of this kind carry it as `backendKind`. */
export const CODEX_BACKEND_KIND = "codex" as const;
export const CODEX_HOST_EXTENSION_ID = "tau.codex";
/** Usage Kit may read each thread's running total through the `usage` command. */
export const USAGE_KIT_ID = "tau.usage";
export const CODEX_NPM_PACKAGE = "@openai/codex";
/**
 * The oldest CLI whose `app-server` protocol this kit speaks. The protocol is
 * marked experimental and moves between releases, so this is the release the
 * kit was built and tested against, not a guess at an older one.
 */
export const MIN_CODEX_VERSION = "0.154.0";

/** What the `status` command reports to the Settings page. */
export interface CodexStatusReport {
  command: string;
  /** Who chose `command`: the environment variable, or the path set on the card; absent for the PATH lookup. */
  commandSource?: "env" | "setting";
  path?: string;
  version?: string;
  latest?: string;
  updateCommand?: string;
  /** `latest` is newer than `version`. */
  updateAvailable?: boolean;
  /** Below `MIN_CODEX_VERSION`: threads refuse to start. */
  unsupported?: boolean;
  /** The CLI's home, where its sessions and login live. */
  codexHome?: string;
  account?: { kind: "chatgpt" | "apiKey" | "other"; plan?: string; email?: string };
  signedIn?: boolean;
  models?: number;
  message?: string;
}
