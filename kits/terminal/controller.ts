import { errorMessage, type WorkbenchActions } from "tau";
import {
  addGroup, detachPane, focusedPane, focusNext, groupOf, isStaged, moveToStage, paneIds, replacePane, returnFromStage, splitAt,
  type SplitDirection, type TerminalGroup,
} from "./layout.js";
import { classifyTerminalLink } from "./links.js";
import { onTerminalEvent, terminalKit, terminalServices, terminalStore } from "./store.js";
import {
  TERMINAL_EXITED_EVENT,
  TERMINAL_PANEL,
  TERMINAL_STAGE_TAB,
  type TerminalExitedEvent,
  type TerminalRunActions,
  type TerminalRunRequest,
  type TerminalRunResult,
  type UiTerminalSession,
} from "./protocol.js";

/**
 * What the panel's buttons, the terminal's own chords and the palette's
 * commands do. The shells live in the host; this sequences host calls with
 * the client's layout, so a new shell lands where it was asked for.
 */

function session(id: string | undefined): UiTerminalSession | undefined {
  return id ? terminalStore.getSnapshot().sessions.find((entry) => entry.id === id) : undefined;
}

/** The shell whose view has the keyboard, in the panel or on the stage. */
export function keyboardShell(): string | undefined {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active?.closest("[data-terminal-id]")?.getAttribute("data-terminal-id") ?? undefined;
}

/** The shell a pane command acts on: the one with the keyboard, else the panel's focused one. */
export function targetShell(): string | undefined {
  const typing = keyboardShell();
  return typing && session(typing) ? typing : focusedPane(terminalStore.getSnapshot().layout);
}

/** Where a new shell belongs: beside the one it splits, in the directory that one is in now, or with the thread on screen. */
function placeFor(actions: TerminalRunActions | undefined, beside?: UiTerminalSession): { workspaceId?: string; sessionId?: string; from?: string } {
  if (beside) return { ...(beside.workspaceId ? { workspaceId: beside.workspaceId } : {}), ...(beside.sessionId ? { sessionId: beside.sessionId } : {}), from: beside.id };
  const thread = actions?.activeThread();
  return { ...(thread?.workspaceId ? { workspaceId: thread.workspaceId } : {}), ...(thread?.sessionId ? { sessionId: thread.sessionId } : {}) };
}

/**
 * Starts a shell and puts it in a panel tab of its own, or beside `target`
 * (the shell with the keyboard by default) when a split asked for it, in the
 * panel or on the stage; the keyboard goes to it.
 */
export async function openTerminal(
  actions: WorkbenchActions | undefined,
  options: { target?: string; direction?: SplitDirection } = {},
): Promise<UiTerminalSession> {
  const beside = options.direction ? session(options.target ?? targetShell()) : undefined;
  const release = terminalStore.hold();
  try {
    const opened = await terminalKit.open(placeFor(actions, beside));
    terminalStore.updateLayout((layout) => beside && options.direction
      ? splitAt(layout, beside.id, opened.id, options.direction)
      : addGroup(layout, opened.id));
    terminalStore.requestFocus(opened.id);
    return opened;
  } finally {
    release();
  }
}

/** The status a shell ended with, or `undefined` once it left the list without one (closed, or the host went away). */
export function shellEnded(id: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    let listed = false;
    let done = false;
    const stops: Array<() => void> = [];
    const finish = (exitCode: number | undefined) => {
      if (done) return;
      done = true;
      for (const stop of stops) stop();
      resolve(exitCode);
    };
    const check = () => {
      const shell = terminalStore.getSnapshot().sessions.find((entry) => entry.id === id);
      if (shell) listed = true;
      if (shell?.exitCode !== undefined) finish(shell.exitCode);
      else if (!shell && listed) finish(undefined);
    };
    stops.push(onTerminalEvent(TERMINAL_EXITED_EVENT, (payload) => {
      const event = payload as Partial<TerminalExitedEvent> | null;
      if (event?.id === id && typeof event.exitCode === "number") finish(event.exitCode);
    }), terminalStore.subscribe(check));
    check();
  });
}

/**
 * Runs a command in a new shell of its own tab and shows the panel; answers
 * once the shell ended. The shell leaves right after the command, so its
 * status is the command's and the output stays to read.
 */
export async function runInTerminal(actions: TerminalRunActions | undefined, request: TerminalRunRequest): Promise<TerminalRunResult> {
  const release = terminalStore.hold();
  let opened: UiTerminalSession;
  try {
    opened = await terminalKit.open({ ...placeFor(actions), ...(request.label ? { label: request.label } : {}) });
    terminalStore.updateLayout((layout) => addGroup(layout, opened.id));
    terminalStore.requestFocus(opened.id);
  } finally {
    release();
  }
  actions?.openPanel(TERMINAL_PANEL);
  const ended = shellEnded(opened.id);
  // `exit` without a status leaves with the last command's in sh, bash, zsh and fish.
  await terminalKit.input({ id: opened.id, data: `${request.command}; exit\r` });
  const exitCode = await ended;
  return exitCode === undefined ? { id: opened.id } : { id: opened.id, exitCode };
}

/** A fresh shell where an ended one was: same pane, in the panel or in its stage tab. */
export async function restartTerminal(id: string): Promise<UiTerminalSession> {
  const release = terminalStore.hold();
  try {
    const restarted = await terminalKit.restart({ id });
    terminalStore.updateLayout((layout) => replacePane(layout, id, restarted.id));
    terminalStore.requestFocus(restarted.id);
    return restarted;
  } finally {
    release();
  }
}

/** Asks before interrupting what runs in the given shells; true means go ahead. */
export async function confirmClose(ids: readonly string[], confirm: (message: string) => boolean = (message) => window.confirm(message)): Promise<boolean> {
  const running: string[] = [];
  for (const id of ids) {
    const answer = await terminalKit.foreground({ id }).catch(() => undefined);
    if (answer?.process) running.push(answer.process);
  }
  if (running.length === 0) return true;
  const names = [...new Set(running)].join(", ");
  return confirm(running.length === 1 ? `${names} is still running. Close the terminal anyway?` : `${names} are still running. Close these terminals anyway?`);
}

/** Ends shells, asking first when a program in one of them would be interrupted. */
export async function closeTerminals(ids: readonly string[], confirm?: (message: string) => boolean): Promise<boolean> {
  if (ids.length === 0 || !(await confirmClose(ids, confirm))) return false;
  const before = groupOf(terminalStore.getSnapshot().layout, ids[0]!);
  for (const id of ids) {
    await terminalKit.kill({ id });
    terminalStore.updateLayout((layout) => detachPane(layout, id));
  }
  // The keyboard stays in the tab the pane left, stage or panel, while it has panes.
  const layout = terminalStore.getSnapshot().layout;
  const left = before ? [...layout.groups, ...layout.stage].find((group) => group.id === before.id) : undefined;
  const next = left?.focused ?? focusedPane(layout);
  if (next) terminalStore.requestFocus(next);
  return true;
}

/** Every shell of a panel tab. */
export function groupPanes(groupId: string): string[] {
  const group = terminalStore.getSnapshot().layout.groups.find((entry) => entry.id === groupId);
  return group ? paneIds(group.root) : [];
}

/** Moves the keyboard to the next pane of the tab `from` is in, else of the panel's tab on screen. */
export function focusNextPane(step: 1 | -1 = 1, from?: string): void {
  terminalStore.updateLayout((layout) => focusNext(layout, step, from));
  const layout = terminalStore.getSnapshot().layout;
  const id = from ? groupOf(layout, from)?.focused : focusedPane(layout);
  if (id) terminalStore.requestFocus(id);
}

/** A stage tab's params: its group's id, and a name for the tab before the shells are known. */
function stageTabParams(group: TerminalGroup): { id: string; label: string } {
  return { id: group.id, label: session(paneIds(group.root)[0])?.label ?? "Terminal" };
}

/** The shell leaves the panel for a stage tab of its own; it keeps running. */
export function moveTerminalToStage(actions: WorkbenchActions, id: string): void {
  if (!session(id)) return;
  terminalStore.updateLayout((layout) => moveToStage(layout, id));
  const group = groupOf(terminalStore.getSnapshot().layout, id);
  if (group) actions.openStageTab(TERMINAL_STAGE_TAB, stageTabParams(group));
  terminalStore.requestFocus(id);
}

/** A terminal stage tab closed: its shells come back to the panel. */
export function returnTerminalToPanel(groupId: string): void {
  terminalStore.updateLayout((layout) => returnFromStage(layout, groupId));
}

/** Shells the kit thinks are on the stage but no stage tab draws any more come back. */
export function syncStageTabs(actions: WorkbenchActions): void {
  const drawn = new Set(actions.stageTabs()
    .filter((tab) => tab.kind === "extension" && tab.tabKind === TERMINAL_STAGE_TAB)
    .map((tab) => String((tab as { params: Record<string, unknown> }).params.id ?? "")));
  for (const group of terminalStore.getSnapshot().layout.stage) if (!drawn.has(group.id)) returnTerminalToPanel(group.id);
}

/** Whether a shell is drawn in a stage tab. */
export function onStage(id: string): boolean {
  return isStaged(terminalStore.getSnapshot().layout, id);
}

/**
 * `mod+j`: shows or hides the panel, in the dock or the drawer. Showing it puts the keyboard in the
 * last shell, starting one when there is none; a shell that is on the stage
 * brings its tab forward instead.
 */
export async function toggleTerminal(actions: WorkbenchActions): Promise<void> {
  const state = terminalStore.getSnapshot();
  if (state.panelVisible) {
    if (actions.closePanel) actions.closePanel(TERMINAL_PANEL);
    else actions.toggleDock();
    return;
  }
  const staged = state.layout.stage.at(-1);
  const inPanel = focusedPane(state.layout);
  if (!inPanel && staged && session(staged.focused)) {
    actions.openStageTab(TERMINAL_STAGE_TAB, stageTabParams(staged));
    terminalStore.requestFocus(staged.focused);
    return;
  }
  actions.openPanel(TERMINAL_PANEL);
  if (inPanel) terminalStore.requestFocus(inPanel);
  else await openTerminal(actions);
}

/** Hands selected output to the composer as an excerpt chip, naming the shell and where it started. */
export function addExcerptToPrompt(target: UiTerminalSession, text: string, actions?: WorkbenchActions): boolean {
  const chips = terminalServices.chips;
  const excerpt = text.split("\n").map((line) => line.trimEnd()).join("\n").replace(/^\n+|\n+$/gu, "");
  if (!chips || !excerpt) return false;
  const shell = target.shell ?? "shell";
  const directory = target.currentCwd ?? target.cwd;
  const where = directory ? ` in ${directory}` : "";
  try {
    chips.addChip({ kind: "text-excerpt", label: `${shell} · ${excerpt.split("\n").length} lines`, payload: { source: `Terminal (${shell}${where})`, text: excerpt } });
    actions?.focusComposer();
    return true;
  } catch (error) {
    actions?.notify(errorMessage(error));
    return false;
  }
}

/** A server on this machine opens in the Preview when Preview Kit is on; anything else in the browser. */
export async function openTerminalLink(text: string, actions: WorkbenchActions | undefined = terminalServices.actions): Promise<void> {
  const target = classifyTerminalLink(text);
  if (!target || !actions) return;
  const preview = terminalServices.preview;
  if (target.kind === "preview" && preview) {
    try {
      await preview.open(target.url, actions);
      return;
    } catch {
      // The Preview could not take it; the browser still can.
    }
  }
  actions.openExternal(target.url);
}
