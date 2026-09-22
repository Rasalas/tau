import { useEffect, useState } from "react";
import { errorMessage, type StageTabHandle, type WorkbenchActions } from "tau";
import { terminalServices, terminalStore, useTerminalKit } from "./store.js";
import { TerminalView } from "./view.js";
import { moveToStage } from "./layout.js";
import { restartTerminal, returnTerminalToPanel } from "./controller.js";
import { TERMINAL_PANEL } from "./protocol.js";

/** What a terminal tab is opened and restored with: the host's own session id. */
export interface TerminalTabParams extends Record<string, unknown> {
  id: string;
  label: string;
}

export function terminalTabParams(params: Record<string, unknown>): TerminalTabParams {
  return { id: String(params.id ?? ""), label: String(params.label ?? "Terminal") };
}

/** Handles already told to return their shell on close; a handle lives as long as its tab. */
const watched = new WeakSet<StageTabHandle>();

/** A tab that came back from storage still draws its shell, so the panel must leave it alone. */
export function restoreTerminalTab(params: Record<string, unknown>): boolean {
  const { id } = terminalTabParams(params);
  if (!id) return false;
  terminalStore.updateLayout((layout) => moveToStage(layout, id));
  return true;
}

/**
 * A terminal on the stage instead of in the dock. The shell itself lives in
 * the host, so this is only another view of it: it replays the scrollback by
 * byte offset like the panel's does. Closing the tab — or "Move to panel" —
 * hands the shell back to the panel; it never ends it. The tab draws only
 * while it is the active one, so which shells are on the stage is kept in
 * the kit's layout, not in this component's lifetime.
 */
export function TerminalStageTab({ params, handle, actions }: { params: TerminalTabParams; handle: StageTabHandle; actions?: WorkbenchActions }) {
  const { sessions } = useTerminalKit();
  const session = sessions.find((entry) => entry.id === params.id);
  const label = session?.label ?? params.label;
  const [error, setError] = useState("");

  useEffect(() => {
    if (watched.has(handle)) return;
    watched.add(handle);
    handle.onClose(() => returnTerminalToPanel(params.id));
  }, [handle, params.id]);
  useEffect(() => { if (actions) terminalServices.actions = actions; }, [actions]);
  useEffect(() => { handle.setTitle(label); }, [handle, label]);

  if (!session) {
    return <div className="stage-empty" role="status">This shell is gone. Close the tab or open a new terminal in the dock.</div>;
  }
  const toPanel = () => {
    if (!actions) return;
    actions.closeStageTab(handle.id);
    actions.openPanel(TERMINAL_PANEL);
    terminalStore.requestFocus(session.id);
  };
  const restart = () => {
    setError("");
    restartTerminal(actions, session.id).catch((problem: unknown) => setError(errorMessage(problem)));
  };
  return <div className="terminal-stage">
    <p className="terminal-status">
      <span>{session.cwd ?? session.label}</span>
      {session.exitCode !== undefined ? <>
        <span> · shell exited with {session.exitCode}</span>
        <button type="button" className="text-button" onClick={restart}>Restart shell</button>
      </> : null}
      {actions ? <button type="button" className="text-button terminal-stage-back" title="The shell keeps running in the dock" onClick={toPanel}>Move to panel</button> : null}
    </p>
    {error && <p role="alert" className="terminal-error">{error}</p>}
    <div className="terminal-surface">
      <TerminalView key={session.id} session={session} place="stage" />
    </div>
  </div>;
}
