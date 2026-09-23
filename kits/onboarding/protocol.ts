// Shared by both halves; no imports, so either side may read it.

export const ONBOARDING_EXTENSION_ID = "tau.onboarding";
export const WELCOME_OVERLAY = "onboarding.welcome";
/** Pushed while `import-sessions` runs: `{ source, done, total }`. */
export const IMPORT_PROGRESS_EVENT = "import-progress";

export type SessionSource = "claude-code" | "codex";

/** The backend kits that list and import their CLI's sessions (`import-scan`, `import-sessions`, granted to this kit). */
export const SESSION_SOURCES: ReadonlyArray<{ source: SessionSource; extensionId: string; label: string }> = [
  { source: "claude-code", extensionId: "tau.claude-code", label: "Claude Code" },
  { source: "codex", extensionId: "tau.codex", label: "Codex" },
];

export interface WelcomeState {
  completed: boolean;
  /** Not completed and no thread yet: the wizard opens by itself. */
  firstStart: boolean;
}

export type ToolId = "claude-code" | "codex" | "gh" | "glab";

/** A CLI of the machine, as `tools` reports it. `path` is absent when it is not installed. */
export interface ToolReport {
  id: ToolId;
  path?: string;
  version?: string;
  /** Only for the tools this kit can ask itself (gh, glab). */
  signedIn?: boolean;
  install: string;
  login: string;
}

export interface ToolsReport {
  platform: string;
  tools: ToolReport[];
}

/** One conversation a CLI ran outside Tau. */
export interface ImportableSession {
  source: SessionSource;
  path: string;
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: number;
  imported: boolean;
}

/** A folder the CLIs, or Pi, worked in. */
export interface ProjectCandidate {
  path: string;
  name: string;
  sources: Array<SessionSource | "pi">;
  threadCount: number;
  lastActiveAt: number;
  git: boolean;
}

export interface Discovery {
  projects: ProjectCandidate[];
  sessions: ImportableSession[];
  /** A scan hit its cap; some conversations may be missing. */
  truncated: boolean;
  /** Sources that could not be asked, with the reason. */
  unavailable: Array<{ source: SessionSource; reason: string }>;
}

export interface ImportProgress {
  source: SessionSource;
  done: number;
  total: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  /** The thread index after the import, for the client to apply. */
  update?: unknown;
}

export function isSessionSource(value: unknown): value is SessionSource {
  return value === "claude-code" || value === "codex";
}
