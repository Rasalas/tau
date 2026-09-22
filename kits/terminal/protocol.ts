/**
 * Terminal Kit's own contract between its host entry and its desktop entry.
 * Tau core does not know these commands; it only routes them by extension id.
 *
 * Sessions are keyed by `workspaceId` (the opaque id the host published, the
 * same string Workspace Kit's commands take) plus an optional thread id, so a
 * terminal outlives the window that opened it and dies with its workspace,
 * not with the client. Data flows as pushes; input and resize as commands.
 */
export const TERMINAL_HOST_EXTENSION_ID = "tau.terminal";

/** Events the host pushes: output of a session, its exit, or the list. */
export const TERMINAL_DATA_EVENT = "data";
export const TERMINAL_EXITED_EVENT = "exited";
export const TERMINAL_LIST_EVENT = "sessions";

/** A pty session, as the panel lists it. */
export interface UiTerminalSession {
  id: string;
  workspaceId?: string;
  /** The thread whose turn opened the terminal, when one did. */
  sessionId?: string;
  /** Absolute path on the host the shell started in; for the user's eyes only. */
  cwd?: string;
  label: string;
  /** The shell's program name (`zsh`), for an excerpt to say where it came from. */
  shell?: string;
  cols: number;
  rows: number;
  /** The shell ended on its own; the entry stays listed until the user closes or restarts it. */
  exitCode?: number;
}

export interface TerminalResizeInput {
  id: string;
  cols: number;
  rows: number;
}

export interface TerminalHostCommands {
  /** Starts a shell in the workspace (the host's own when unnamed) and answers with the session. */
  "open": { input: { workspaceId?: string; sessionId?: string; label?: string }; output: UiTerminalSession };
  /** A new shell in an ended session's place; answers with the replacement. */
  "restart": { input: { id: string }; output: UiTerminalSession };
  /** Writes what the user typed; travels as plain text over the host's own channel. */
  "input": { input: { id: string; data: string }; output: void };
  /** New size of the pty, as the renderer measured it. */
  "resize": { input: TerminalResizeInput; output: void };
  /** Ends the session: kills a running shell, drops an ended one from the list. */
  "kill": { input: { id: string }; output: void };
  /** Every session the host still holds, for a client that reconnected. */
  "list": { input: undefined; output: UiTerminalSession[] };
  /** One session's scrollback, so a reloaded renderer can redraw where it was. */
  "replay": { input: { id: string }; output: { data: string; offset: number } | undefined };
  /** A program other than the shell running in its foreground; closing would interrupt it. */
  "foreground": { input: { id: string }; output: { process?: string } };
  /** The font the user's Ghostty config names on the host, read and never written. */
  "font": { input: undefined; output: TerminalFontDefaults };
}

/** What the host found in the user's Ghostty config; empty when there is none. */
export interface TerminalFontDefaults {
  /** `font-family` entries in order: the first is the face, the rest its fallbacks. */
  families: string[];
  /** `font-size` in points, which the window draws as CSS pixels. */
  size?: number;
  /** The files that were read, for the settings page to name. */
  files: string[];
  problems: string[];
}

export type TerminalHostClient = {
  [Command in keyof TerminalHostCommands]: TerminalHostCommands[Command]["input"] extends undefined
    ? () => Promise<TerminalHostCommands[Command]["output"]>
    : (input: TerminalHostCommands[Command]["input"]) => Promise<TerminalHostCommands[Command]["output"]>;
};

export function createTerminalHostClient(invoke: (command: string, input?: unknown) => Promise<unknown>): TerminalHostClient {
  const call = <Command extends keyof TerminalHostCommands>(command: Command) =>
    (input?: unknown) => invoke(command, input) as Promise<TerminalHostCommands[Command]["output"]>;
  return {
    open: call("open"),
    restart: call("restart"),
    input: call("input"),
    resize: call("resize"),
    kill: call("kill"),
    list: call("list"),
    replay: call("replay"),
    font: call("font"),
    foreground: call("foreground"),
  } as TerminalHostClient;
}

export interface TerminalDataEvent {
  id: string;
  /** Bytes the session had produced after this chunk; a client drops what it already drew. */
  offset: number;
  /** Chunk of terminal output, UTF-8. */
  data: string;
}

export interface TerminalExitedEvent {
  id: string;
  exitCode: number;
}

export const TERMINAL_PANEL = "terminal";

/** The stage tab kind this kit registers; one tab per shell. */
export const TERMINAL_STAGE_TAB = "terminal";

/** Order the panel is drawn in the dock rail, after Files and Changes. */
export const TERMINAL_PANEL_ORDER = 25;

/** Commands in the palette; `terminal.toggle` is also `mod+j`. */
export const TERMINAL_COMMANDS = {
  toggle: "terminal.toggle",
  new: "terminal.new",
  split: "terminal.split",
  splitDown: "terminal.splitDown",
  close: "terminal.close",
  focusNext: "terminal.focusNext",
} as const;

// Mirrors of other kits' contracts. They are named here, not imported: a kit
// never imports another kit, and each use degrades when the other kit is off.

/** Composer Context's chip service (`kits/composer-context/protocol.ts`); only the excerpt this kit hands over. */
export const COMPOSER_CONTEXT_CHIPS_SERVICE = "tau.composer-context/chips";
export interface ComposerContextChips {
  addChip(chip: { kind: "text-excerpt"; label?: string; payload: { source: string; text: string } }): string;
}

/** Preview Kit's desktop service (`kits/preview/protocol.ts`). */
export const PREVIEW_BROWSER_SERVICE = "tau.preview/browser";
export interface PreviewBrowserService {
  open(url: string, actions: { openPanel(id: string): void }): Promise<void>;
}
