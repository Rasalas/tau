import { useEffect, useRef, useState } from "react";
import { Columns2, Rows2, X } from "lucide-react";
import { errorMessage, tooltipProps, useHostCapabilities, type StageTabHandle, type WorkbenchActions } from "tau";
import { terminalServices, terminalStore, useTerminalKit } from "./store.js";
import { paneIds, restoreStageGroup, stageGroup } from "./layout.js";
import { closeTerminals, openTerminal, returnTerminalToPanel } from "./controller.js";
import { groupLabel, PaneTree, type Run } from "./panes.js";
import { TERMINAL_PANEL } from "./protocol.js";

/** What a terminal tab is opened and restored with: the id of the stage group it draws. */
export interface TerminalTabParams extends Record<string, unknown> {
  id: string;
  label: string;
}

export function terminalTabParams(params: Record<string, unknown>): TerminalTabParams {
  return { id: String(params.id ?? ""), label: String(params.label ?? "Terminal") };
}

/** Handles already told to return their shells on close; a handle lives as long as its tab. */
const watched = new WeakSet<StageTabHandle>();

/** A tab that came back from storage still draws its shells, so the panel must leave them alone. */
export function restoreTerminalTab(params: Record<string, unknown>): boolean {
  const { id } = terminalTabParams(params);
  if (!id) return false;
  terminalStore.updateLayout((layout) => restoreStageGroup(layout, id));
  return true;
}

/**
 * Terminals on the stage instead of in the panel: one stage group, split like
 * a panel tab. The shells live in the host, so this is only another view of
 * them. Closing the tab — or "Move to panel" — hands them back to the panel
 * as one tab; it never ends them. Closing its last shell closes the tab.
 */
export function TerminalStageTab({ params, handle, actions }: { params: TerminalTabParams; handle: StageTabHandle; actions?: WorkbenchActions }) {
  const { sessions, layout, activeSessionId } = useTerminalKit();
  const group = stageGroup(layout, params.id);
  const live = group ? paneIds(group.root).some((id) => sessions.some((session) => session.id === id)) : false;
  const label = (group ? groupLabel(group, sessions) : undefined) ?? params.label;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const { readOnly } = useHostCapabilities();
  const drawn = useRef(false);
  if (live) drawn.current = true;

  useEffect(() => {
    if (watched.has(handle)) return;
    watched.add(handle);
    handle.onClose(() => returnTerminalToPanel(params.id));
  }, [handle, params.id]);
  useEffect(() => { if (actions) terminalServices.actions = actions; }, [actions]);
  useEffect(() => { handle.setTitle(label); }, [handle, label]);
  // The tab had shells and has none now: its last one was closed.
  useEffect(() => { if (!group && drawn.current && actions) actions.closeStageTab(handle.id); }, [group, actions, handle.id]);

  if (!group || !live) {
    return <div className="stage-empty" role="status">This shell is gone. Close the tab or open a new terminal in the dock.</div>;
  }
  const run: Run = (work) => {
    setBusy(true);
    setError("");
    void Promise.resolve().then(work).catch((problem: unknown) => setError(errorMessage(problem))).finally(() => setBusy(false));
  };
  const toPanel = () => {
    if (!actions) return;
    const focused = group.focused;
    actions.closeStageTab(handle.id);
    actions.openPanel(TERMINAL_PANEL);
    terminalStore.requestFocus(focused);
  };
  return <div className="terminal-stage">
    <header className="terminal-stage-header">
      {readOnly ? null : <>
      <button type="button" className="icon-button" aria-label="Split right" title="Split right (⌘D in a terminal)" disabled={busy} onClick={() => run(() => openTerminal(actions, { direction: "right", target: group.focused }))}><Columns2 size={14} /></button>
      <button type="button" className="icon-button" aria-label="Split down" title="Split down (⌘⇧D in a terminal)" disabled={busy} onClick={() => run(() => openTerminal(actions, { direction: "down", target: group.focused }))}><Rows2 size={14} /></button>
      </>}
      {!readOnly && group.root.kind === "pane" ? <CloseShellButton id={group.focused} label={label} run={run} /> : null}
      {actions ? <button type="button" className="text-button terminal-stage-back" title="The shells keep running in the panel" onClick={toPanel}>Move to panel</button> : null}
    </header>
    {error && <p role="alert" className="terminal-error">{error}</p>}
    <div className="terminal-surface">
      <PaneTree group={group} sessions={sessions} place="stage" actions={actions} run={run} activeSessionId={actions?.activeThread()?.sessionId ?? activeSessionId} />
    </div>
  </div>;
}

/** A pane alone in its tab has no header of its own; the tab's bar closes it. */
function CloseShellButton({ id, label, run }: { id: string; label: string; run: Run }) {
  return <button type="button" className="icon-button" aria-label={`Close ${label}`} {...tooltipProps("Close this shell")} onClick={() => run(() => closeTerminals([id]))}><X size={14} /></button>;
}
