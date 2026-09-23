import { useEffect, useState } from "react";
import { Columns2, Plus, Rows2 } from "lucide-react";
import { errorMessage, type PanelProps } from "tau";
import { terminalServices, terminalStore, useTerminalKit } from "./store.js";
import { focusedPane, paneIds } from "./layout.js";
import { closeTerminals, groupPanes, openTerminal, syncStageTabs } from "./controller.js";
import { groupLabel, PaneTree, PLACE_LABEL, placeOf, type Run } from "./panes.js";

export { placeOf, type TerminalPlace } from "./panes.js";

export function TerminalPanel({ actions, active }: PanelProps) {
  const { sessions, activeSessionId: switched, layout } = useTerminalKit();
  // The thread on screen, asked on every render: the store's copy only says
  // that it changed, and is empty until the first switch after activation.
  const activeSessionId = actions.activeThread()?.sessionId ?? switched;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { terminalServices.actions = actions; }, [actions]);
  useEffect(() => {
    terminalStore.setPanelVisible(active);
    return () => terminalStore.setPanelVisible(false);
  }, [active]);
  // A stage tab closed while nothing drew it had no one to tell the panel.
  useEffect(() => { syncStageTabs(actions); });

  const run: Run = (work) => {
    setBusy(true);
    setError("");
    void Promise.resolve().then(work).catch((problem: unknown) => setError(errorMessage(problem))).finally(() => setBusy(false));
  };
  const byId = (id: string) => sessions.find((session) => session.id === id);
  const current = layout.groups.find((group) => group.id === layout.active);
  const target = focusedPane(layout);
  const running = sessions.filter((session) => session.exitCode === undefined && placeOf(session, activeSessionId) === "elsewhere").length;
  const onStage = layout.stage.flatMap((group) => paneIds(group.root)).filter((id) => byId(id)).length;

  return <section className="panel-body terminal-panel">
    <header className="panel-header">
      <h2>Terminal</h2>
      <span className="terminal-panel-actions">
        <button className="icon-button" aria-label="New terminal" title="New terminal (⌘N in a terminal)" disabled={busy} onClick={() => run(() => openTerminal(actions))}><Plus size={14} /></button>
        <button className="icon-button" aria-label="Split right" title="Split right (⌘D in a terminal)" disabled={busy || !target} onClick={() => run(() => openTerminal(actions, { direction: "right", ...(target ? { target } : {}) }))}><Columns2 size={14} /></button>
        <button className="icon-button" aria-label="Split down" title="Split down (⌘⇧D in a terminal)" disabled={busy || !target} onClick={() => run(() => openTerminal(actions, { direction: "down", ...(target ? { target } : {}) }))}><Rows2 size={14} /></button>
      </span>
    </header>
    {running > 0 && <p className="terminal-note" role="status">{running === 1 ? "A shell is still running in another thread." : `${running} shells are still running in other threads.`}</p>}
    <div className="terminal-tabs" role="tablist" aria-label="Terminals">
      {layout.groups.map((group) => {
        const ids = paneIds(group.root);
        const first = byId(ids[0]!);
        if (!first) return null;
        const place = placeOf(first, activeSessionId);
        const exited = ids.every((id) => byId(id)?.exitCode !== undefined);
        const selected = group.id === current?.id;
        const label = groupLabel(group, sessions) ?? first.label;
        return <div key={group.id} className={`terminal-tab ${selected ? "active" : ""} place-${place}`}>
          <button
            type="button"
            role="tab"
            className="text-button terminal-tab-name"
            aria-selected={selected}
            title={`${first.currentCwd ?? first.cwd ?? first.label} · ${PLACE_LABEL[place]}`}
            onClick={() => {
              terminalStore.updateLayout((next) => ({ ...next, active: group.id }));
              terminalStore.requestFocus(group.focused);
            }}
          >
            {label}
            {place !== "thread" && <span className="terminal-tab-place">{PLACE_LABEL[place]}</span>}
            {exited && <span className="terminal-tab-place">exited</span>}
          </button>
          <button type="button" className="text-button" aria-label={`Close tab ${label}`} onClick={() => run(() => closeTerminals(groupPanes(group.id)))}>×</button>
        </div>;
      })}
    </div>
    {error && <p role="alert" className="terminal-error">{error}</p>}
    {onStage > 0 && <p className="terminal-note">{onStage === 1 ? "One shell is open as a stage tab." : `${onStage} shells are open as stage tabs.`}</p>}
    <div className="terminal-surface">
      {current
        ? <PaneTree group={current} sessions={sessions} place="panel" actions={actions} run={run} activeSessionId={activeSessionId} />
        : <p className="empty-copy">{onStage > 0 ? "Every shell is on the stage." : "Open a terminal to run commands in this workspace."}</p>}
    </div>
  </section>;
}
