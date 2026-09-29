/**
 * Project Scripts' own contract between its host entry and its desktop entry.
 * Tau core does not know these commands; it only routes them by extension id.
 */
export const PROJECT_SCRIPTS_HOST_EXTENSION_ID = "tau.project-scripts";

/** Where a repository describes its scripts, relative to the checkout. */
export const PROJECT_FILE = ".tau/project.json";

/** Glyphs a script may ask for; the set other tools' `t3.json` uses. */
export const SCRIPT_ICONS = ["play", "test", "lint", "configure", "build", "debug"] as const;
export type ScriptIcon = typeof SCRIPT_ICONS[number];

/** One entry of `scripts` in the project file, with its defaults applied. */
export interface ProjectScript {
  /** Stable id: the file's own, or a slug of the name. `script.<id>.run` is its command. */
  id: string;
  name: string;
  command: string;
  icon: ScriptIcon;
  /** A chord in the workbench's spelling, e.g. `mod+shift+r`. */
  keybinding?: string;
  /** Runs once in every worktree Workspace Kit creates for a new thread. */
  runOnWorktreeCreate: boolean;
  /** For a worktree setup: false holds the new thread until the script exits. */
  async: boolean;
  previewUrl?: string;
  /** Opens `previewUrl` once it answers; true unless the file says false. */
  autoOpenPreview: boolean;
}

export interface ProjectFileProblem {
  /** The file the problem is in, absolute on the host. */
  source: string;
  message: string;
  level: "error" | "warning";
}

export type ScriptRunStatus = "running" | "succeeded" | "failed" | "stopped";

/** One run of a script, as the bar draws its card. */
export interface UiScriptRun {
  id: string;
  scriptId: string;
  name: string;
  command: string;
  icon: ScriptIcon;
  /** Absolute directory the script runs in: the thread's worktree or the project. */
  directory: string;
  sessionId?: string;
  trigger: "user" | "worktree-create";
  status: ScriptRunStatus;
  exitCode?: number;
  signal?: string;
  startedAt: number;
  endedAt?: number;
  /** The last part of stdout and stderr, interleaved as they arrived. */
  output: string;
  /** Characters the process wrote in total; more than `output` holds once it was cut. */
  outputLength: number;
  previewUrl?: string;
  autoOpenPreview: boolean;
  /** The preview URL answered (or the wait for it gave up): time to open it. */
  previewReady?: boolean;
}

export type SetupStageStatus = "pending" | "running" | "done" | "failed" | "skipped";

/** One step of a worktree setup: a Git step, or one `runOnWorktreeCreate` script. */
export interface UiSetupStage {
  /** `fetch`, `checkout`, or `script:<id>`. */
  id: string;
  label: string;
  status: SetupStageStatus;
  startedAt?: number;
  endedAt?: number;
  /** Short trailing text: an exit code, "cancelled". */
  detail?: string;
  /** The script's last lines, colour codes stripped, newest last. */
  tail: string[];
  command?: string;
  /** The thread does not wait for this script. */
  async?: boolean;
  runId?: string;
}

/** A new thread's worktree being set up, step by step, as the card draws it. */
export interface UiWorktreeSetup {
  id: string;
  /** The checkout the thread was started from. */
  project: string;
  /** The new worktree, once it exists. */
  worktree?: string;
  branch?: string;
  phase: "running" | "done" | "failed" | "cancelled";
  startedAt: number;
  endedAt?: number;
  stages: UiSetupStage[];
  /** Why the worktree could not be made. */
  error?: string;
  /** The user let the thread start before the blocking scripts ended. */
  released?: boolean;
}

/** What `list` answers for one directory. */
export interface ProjectScriptsState {
  directory: string;
  /** The project file's absolute path, whether or not it exists. */
  file: string;
  exists: boolean;
  scripts: ProjectScript[];
  problems: ProjectFileProblem[];
}

/** Which checkout a command means: the thread's own, else the workspace's, else the host's. */
export interface ScriptScope {
  sessionId?: string;
  workspaceId?: string;
}

export interface ProjectScriptsHostCommands {
  "list": { input: ScriptScope; output: ProjectScriptsState };
  "run": { input: ScriptScope & { scriptId: string }; output: { run: UiScriptRun; started: boolean } };
  "stop": { input: { runId: string }; output: void };
  "dismiss": { input: { runId: string }; output: void };
  "runs": { input: undefined; output: UiScriptRun[] };
  /** Every worktree setup the host still holds. */
  "setups": { input: undefined; output: UiWorktreeSetup[] };
  /** Stops the setup's scripts; the ones not started yet never start, and the thread starts in the worktree. */
  "setup-cancel": { input: { setupId: string }; output: void };
  /** Starts the thread now; blocking scripts go on in the background. */
  "setup-release": { input: { setupId: string }; output: void };
  "setup-dismiss": { input: { setupId: string }; output: void };
}

export type ProjectScriptsHostClient = {
  [Command in keyof ProjectScriptsHostCommands]: ProjectScriptsHostCommands[Command]["input"] extends undefined
    ? () => Promise<ProjectScriptsHostCommands[Command]["output"]>
    : (input: ProjectScriptsHostCommands[Command]["input"]) => Promise<ProjectScriptsHostCommands[Command]["output"]>;
};

export function createProjectScriptsHostClient(invoke: (command: string, input?: unknown) => Promise<unknown>): ProjectScriptsHostClient {
  const call = <Command extends keyof ProjectScriptsHostCommands>(command: Command) =>
    (input?: unknown) => invoke(command, input) as Promise<ProjectScriptsHostCommands[Command]["output"]>;
  return {
    list: call("list"),
    run: call("run"),
    stop: call("stop"),
    dismiss: call("dismiss"),
    runs: call("runs"),
    setups: call("setups"),
    "setup-cancel": call("setup-cancel"),
    "setup-release": call("setup-release"),
    "setup-dismiss": call("setup-dismiss"),
  } as ProjectScriptsHostClient;
}

/**
 * Workspace Kit calls this after it created a worktree, and Remote Work Kit
 * after it made one for another machine's transfer; only they may (`callers`). The answer says what ran; a script that fails is reported in
 * its run, never thrown, so the worktree stays.
 */
export const WORKTREE_CREATED_COMMAND = "worktree-created";
export interface WorktreeCreatedInput {
  project: string;
  worktree: string;
  /** The setup `worktree-setup-begin` opened; one is opened here without it. */
  setupId?: string;
}

/**
 * Workspace Kit reports the steps before the scripts, so the card shows the
 * whole setup from the moment the thread's first prompt was sent (callers
 * `tau.workspace`): `begin` answers `{ setupId }`, `step` moves to a Git step,
 * `failed` ends a setup whose worktree could not be made.
 */
export const WORKTREE_SETUP_BEGIN_COMMAND = "worktree-setup-begin";
export const WORKTREE_SETUP_STEP_COMMAND = "worktree-setup-step";
export const WORKTREE_SETUP_FAILED_COMMAND = "worktree-setup-failed";

/** Pushed with the whole record whenever a run starts, writes, ends or can show its preview. */
export const RUN_EVENT = "run";
/** Pushed when a finished run was dismissed. */
export const RUN_DISMISSED_EVENT = "run-dismissed";
/** Pushed with the whole setup whenever one of its steps moves. */
export const SETUP_EVENT = "setup";
/** Pushed when a settled setup was dismissed. */
export const SETUP_DISMISSED_EVENT = "setup-dismissed";
/** Pushed when a watched project file changed; the client asks `list` again. */
export const SCRIPTS_CHANGED_EVENT = "scripts-changed";

/** The command id a script runs under, and the one a keybinding names. */
export function scriptCommandId(scriptId: string): string {
  return `script.${scriptId}.run`;
}

// Mirrors of other kits' contracts. They are named here, not imported: a kit
// never imports another kit, and each call fails like any other without it.

/** Preview Kit's desktop service (`kits/preview/protocol.ts`). */
export const PREVIEW_BROWSER_SERVICE = "tau.preview/browser";
export interface PreviewBrowserService {
  open(url: string, actions: { openPanel(id: string): void }): Promise<void>;
}

/** Terminal Kit's host entry and panel (`kits/terminal/protocol.ts`). */
export const TERMINAL_HOST_EXTENSION_ID = "tau.terminal";
export const TERMINAL_PANEL = "terminal";
