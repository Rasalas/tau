import { errorMessage, type WorkbenchActions } from "tau";
import { addGroup, detachPane, focusedPane, focusNext, moveToStage, paneIds, replacePane, returnFromStage, splitAt, type SplitDirection } from "./layout.js";
import { classifyTerminalLink } from "./links.js";
import { terminalKit, terminalServices, terminalStore } from "./store.js";
import { TERMINAL_PANEL, TERMINAL_STAGE_TAB, type UiTerminalSession } from "./protocol.js";

/**
 * What the panel's buttons, the terminal's own chords and the palette's
 * commands do. The shells live in the host; this sequences host calls with
 * the client's layout, so a new shell lands where it was asked for.
 */

function session(id: string | undefined): UiTerminalSession | undefined {
  return id ? terminalStore.getSnapshot().sessions.find((entry) => entry.id === id) : undefined;
}

/** Where a new shell belongs: beside the one it splits, or with the thread on screen. */
function placeFor(actions: WorkbenchActions | undefined, beside?: UiTerminalSession): { workspaceId?: string; sessionId?: string } {
  if (beside) return { ...(beside.workspaceId ? { workspaceId: beside.workspaceId } : {}), ...(beside.sessionId ? { sessionId: beside.sessionId } : {}) };
  const thread = actions?.activeThread();
  return { ...(thread?.workspaceId ? { workspaceId: thread.workspaceId } : {}), ...(thread?.sessionId ? { sessionId: thread.sessionId } : {}) };
}

/**
 * Starts a shell and puts it in a tab of its own, or beside `target` when a
 * split asked for it; the keyboard goes to it.
 */
export async function openTerminal(
  actions: WorkbenchActions | undefined,
  options: { target?: string; direction?: SplitDirection } = {},
): Promise<UiTerminalSession> {
  const beside = options.direction ? session(options.target ?? focusedPane(terminalStore.getSnapshot().layout)) : undefined;
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

/** A fresh shell where an ended one was: same pane, or same stage tab. */
export async function restartTerminal(actions: WorkbenchActions | undefined, id: string): Promise<UiTerminalSession> {
  const release = terminalStore.hold();
  try {
    const restarted = await terminalKit.restart({ id });
    const staged = terminalStore.getSnapshot().layout.onStage.includes(id);
    terminalStore.updateLayout((layout) => replacePane(layout, id, restarted.id));
    if (staged && actions) {
      actions.stageTabs().filter((tab) => tab.kind === "extension" && tab.tabKind === TERMINAL_STAGE_TAB && (tab as { params: Record<string, unknown> }).params.id === id)
        .forEach((tab) => actions.closeStageTab(tab.id));
      terminalStore.updateLayout((layout) => layout.onStage.includes(restarted.id) ? layout : moveToStage(layout, restarted.id));
      actions.openStageTab(TERMINAL_STAGE_TAB, { id: restarted.id, label: restarted.label });
    }
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
  for (const id of ids) {
    await terminalKit.kill({ id });
    terminalStore.updateLayout((layout) => detachPane(layout, id));
  }
  const next = focusedPane(terminalStore.getSnapshot().layout);
  if (next) terminalStore.requestFocus(next);
  return true;
}

/** Every shell of a panel tab. */
export function groupPanes(groupId: string): string[] {
  const group = terminalStore.getSnapshot().layout.groups.find((entry) => entry.id === groupId);
  return group ? paneIds(group.root) : [];
}

/** Moves the keyboard to the next pane of the tab on screen. */
export function focusNextPane(step: 1 | -1 = 1): void {
  terminalStore.updateLayout((layout) => focusNext(layout, step));
  const id = focusedPane(terminalStore.getSnapshot().layout);
  if (id) terminalStore.requestFocus(id);
}

/** The shell leaves the panel for a stage tab; it keeps running. */
export function moveTerminalToStage(actions: WorkbenchActions, id: string): void {
  const target = session(id);
  if (!target) return;
  actions.openStageTab(TERMINAL_STAGE_TAB, { id, label: target.label });
  terminalStore.updateLayout((layout) => moveToStage(layout, id));
  terminalStore.requestFocus(id);
}

/** A terminal stage tab closed: the shell comes back to the panel. */
export function returnTerminalToPanel(id: string): void {
  terminalStore.updateLayout((layout) => returnFromStage(layout, id));
}

/** Shells the kit thinks are on the stage but no stage tab draws any more come back. */
export function syncStageTabs(actions: WorkbenchActions): void {
  const drawn = new Set(actions.stageTabs()
    .filter((tab) => tab.kind === "extension" && tab.tabKind === TERMINAL_STAGE_TAB)
    .map((tab) => String((tab as { params: Record<string, unknown> }).params.id ?? "")));
  for (const id of terminalStore.getSnapshot().layout.onStage) if (!drawn.has(id)) returnTerminalToPanel(id);
}

/**
 * `mod+j`: shows or hides the panel. Showing it puts the keyboard in the
 * last shell, starting one when there is none; a shell that is on the stage
 * brings its tab forward instead.
 */
export async function toggleTerminal(actions: WorkbenchActions): Promise<void> {
  const state = terminalStore.getSnapshot();
  if (state.panelVisible) {
    actions.toggleDock();
    return;
  }
  const staged = state.layout.onStage.at(-1);
  const inPanel = focusedPane(state.layout);
  if (!inPanel && staged && session(staged)) {
    actions.openStageTab(TERMINAL_STAGE_TAB, { id: staged, label: session(staged)!.label });
    terminalStore.requestFocus(staged);
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
  const where = target.cwd ? ` in ${target.cwd}` : "";
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
