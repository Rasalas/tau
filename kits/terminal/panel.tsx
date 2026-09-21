import { useMemo, useState } from "react";
import { errorMessage, type PanelProps } from "tau";
import { TerminalView } from "./view.js";
import { terminalKit, useTerminalKit } from "./store.js";
import { TERMINAL_STAGE_TAB, type UiTerminalSession } from "./protocol.js";

/** Where a terminal sits relative to the thread on screen; the panel marks the ones that are not here. */
export type TerminalPlace = "thread" | "project" | "elsewhere";

export function placeOf(session: UiTerminalSession, activeSessionId: string | undefined): TerminalPlace {
  if (!session.sessionId) return "project";
  return session.sessionId === activeSessionId ? "thread" : "elsewhere";
}

const PLACE_LABEL: Record<TerminalPlace, string> = {
  thread: "this thread",
  project: "project",
  elsewhere: "another thread",
};

export function TerminalPanel({ actions }: PanelProps) {
  const { sessions, activeSessionId: switched, onStage } = useTerminalKit();
  // The thread on screen, asked on every render: the store's copy only says
  // that it changed, and is empty until the first switch after activation.
  const activeSessionId = actions.activeThread()?.sessionId ?? switched;
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useMemo(() => sessions.find((session) => session.id === selected) ?? sessions[0], [sessions, selected]);
  const run = async (work: () => Promise<UiTerminalSession | void>) => {
    setBusy(true);
    setError("");
    try {
      const session = await work();
      if (session) setSelected(session.id);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };
  const open = () => run(() => {
    const thread = actions.activeThread();
    return terminalKit.open({ ...(thread?.workspaceId ? { workspaceId: thread.workspaceId } : {}), ...(thread?.sessionId ? { sessionId: thread.sessionId } : {}) });
  });
  const restart = (id: string) => run(() => terminalKit.restart({ id }));
  const close = (id: string) => run(() => terminalKit.kill({ id }));
  const openAsTab = (session: UiTerminalSession) => {
    setError("");
    try { actions.openStageTab(TERMINAL_STAGE_TAB, { id: session.id, label: session.label }); }
    catch (problem) { setError(errorMessage(problem)); }
  };
  const staged = (id: string) => onStage.includes(id);
  const running = sessions.filter((session) => session.exitCode === undefined && placeOf(session, activeSessionId) === "elsewhere").length;

  return <section className="panel-body terminal-panel">
    <header className="panel-header">
      <h2>Terminal</h2>
      <button className="text-button" disabled={busy} onClick={() => void open()}>New terminal</button>
    </header>
    {running > 0 && <p className="terminal-note" role="status">{running === 1 ? "A shell is still running in another thread." : `${running} shells are still running in other threads.`}</p>}
    <div className="terminal-tabs" role="tablist" aria-label="Terminals">
      {sessions.map((session) => {
        const place = placeOf(session, activeSessionId);
        const state = session.exitCode === undefined ? "running" : `exited ${session.exitCode}`;
        return <div key={session.id} className={`terminal-tab ${session.id === current?.id ? "active" : ""} place-${place}`}>
          <button
            type="button"
            role="tab"
            className="text-button terminal-tab-name"
            aria-selected={session.id === current?.id}
            title={`${session.cwd ?? session.label} · ${PLACE_LABEL[place]} · ${state}`}
            onClick={() => setSelected(session.id)}
          >
            {session.label}
            {place !== "thread" && <span className="terminal-tab-place">{PLACE_LABEL[place]}</span>}
            {staged(session.id) && <span className="terminal-tab-place">on the stage</span>}
            {session.exitCode !== undefined && <span className="terminal-tab-place">exited</span>}
          </button>
          {!staged(session.id) && <button
            type="button"
            className="text-button"
            aria-label={`Open ${session.label} as tab`}
            title="Move this shell to the stage; it keeps running"
            onClick={() => openAsTab(session)}
          >↗</button>}
          <button type="button" className="text-button" aria-label={`Close ${session.label}`} onClick={() => void close(session.id)}>×</button>
        </div>;
      })}
    </div>
    {error && <p role="alert" className="terminal-error">{error}</p>}
    {current && <p className="terminal-status">
      <span>{current.cwd ?? current.label}</span>
      {current.exitCode !== undefined && <>
        <span> · shell exited with {current.exitCode}</span>
        <button type="button" className="text-button" disabled={busy} onClick={() => void restart(current.id)}>Restart shell</button>
      </>}
    </p>}
    <div className="terminal-surface">
      {!current
        ? <p className="empty-copy">Open a terminal to run commands in this workspace.</p>
        : staged(current.id)
          ? <p className="empty-copy">This shell is open as a stage tab.</p>
          : <TerminalView key={current.id} id={current.id} cols={current.cols} rows={current.rows} exitCode={current.exitCode} />}
    </div>
  </section>;
}
