import { useEffect, useState } from "react";
import { errorMessage, type PanelProps, type WorkbenchActions } from "tau";
import { TerminalView } from "./view.js";
import { terminalServices, terminalStore, useTerminalKit } from "./store.js";
import { focusedPane, paneIds, type PaneNode, type TerminalGroup } from "./layout.js";
import type { TerminalChordAction } from "./keys.js";
import { closeTerminals, focusNextPane, groupPanes, moveTerminalToStage, openTerminal, restartTerminal, syncStageTabs } from "./controller.js";
import type { UiTerminalSession } from "./protocol.js";

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

type Run = (work: () => Promise<unknown> | unknown) => void;

/** What a focused terminal's own chords do in the panel. */
function chordHandler(actions: WorkbenchActions, id: string, run: Run) {
  return (action: TerminalChordAction) => {
    if (action === "split-right") run(() => openTerminal(actions, { target: id, direction: "right" }));
    else if (action === "split-down") run(() => openTerminal(actions, { target: id, direction: "down" }));
    else if (action === "new") run(() => openTerminal(actions));
    else if (action === "close") run(() => closeTerminals([id]));
    else focusNextPane(action === "focus-next" ? 1 : -1);
  };
}

function Pane({ session, group, split, actions, run, activeSessionId }: {
  session: UiTerminalSession;
  group: TerminalGroup;
  split: boolean;
  actions: WorkbenchActions;
  run: Run;
  activeSessionId: string | undefined;
}) {
  const place = placeOf(session, activeSessionId);
  const exited = session.exitCode !== undefined;
  return <section className="terminal-pane" aria-label={session.label}>
    <header className="terminal-pane-header">
      <span className="terminal-pane-title" title={session.cwd ?? session.label}>{split ? session.label : session.cwd ?? session.label}</span>
      {place === "elsewhere" && <span className="terminal-tab-place">{PLACE_LABEL[place]}</span>}
      {exited && <>
        <span className="terminal-pane-exit">shell exited with {session.exitCode}</span>
        <button type="button" className="text-button" onClick={() => run(() => restartTerminal(actions, session.id))}>Restart shell</button>
      </>}
      <span className="terminal-pane-actions">
        <button
          type="button"
          className="text-button"
          aria-label={`Open ${session.label} as tab`}
          title="Move this shell to the stage; it keeps running"
          onClick={() => run(() => moveTerminalToStage(actions, session.id))}
        >↗</button>
        <button type="button" className="text-button" aria-label={`Close ${session.label}`} title="Close this shell (⌘W)" onClick={() => run(() => closeTerminals([session.id]))}>×</button>
      </span>
    </header>
    <TerminalView session={session} place="panel" focused={split && group.focused === session.id} onChord={chordHandler(actions, session.id, run)} />
  </section>;
}

function PaneTree({ node, ...rest }: { node: PaneNode; sessions: readonly UiTerminalSession[] } & Omit<Parameters<typeof Pane>[0], "session">) {
  if (node.kind === "pane") {
    const session = rest.sessions.find((entry) => entry.id === node.id);
    return session ? <Pane session={session} {...rest} /> : null;
  }
  return <div className={`terminal-split terminal-split-${node.direction}`}>
    {node.children.map((child) => <PaneTree key={paneIds(child).join(":")} node={child} {...rest} />)}
  </div>;
}

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
  const onStage = layout.onStage.filter((id) => byId(id)).length;

  return <section className="panel-body terminal-panel">
    <header className="panel-header">
      <h2>Terminal</h2>
      <span className="terminal-panel-actions">
        <button className="text-button" disabled={busy} onClick={() => run(() => openTerminal(actions))}>New terminal</button>
        <button className="text-button" disabled={busy || !target} title="Split right (⌘D in a terminal)" onClick={() => run(() => openTerminal(actions, { direction: "right" }))}>Split</button>
        <button className="text-button" disabled={busy || !target} title="Split down (⌘⇧D in a terminal)" onClick={() => run(() => openTerminal(actions, { direction: "down" }))}>Split down</button>
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
        const label = ids.length > 1 ? `${first.label} +${ids.length - 1}` : first.label;
        return <div key={group.id} className={`terminal-tab ${selected ? "active" : ""} place-${place}`}>
          <button
            type="button"
            role="tab"
            className="text-button terminal-tab-name"
            aria-selected={selected}
            title={`${first.cwd ?? first.label} · ${PLACE_LABEL[place]}`}
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
        ? <PaneTree node={current.root} sessions={sessions} group={current} split={current.root.kind === "split"} actions={actions} run={run} activeSessionId={activeSessionId} />
        : <p className="empty-copy">{onStage > 0 ? "Every shell is on the stage." : "Open a terminal to run commands in this workspace."}</p>}
    </div>
  </section>;
}
