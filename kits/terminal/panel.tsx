import { useEffect, useRef, useState } from "react";
import { Columns2, Ellipsis, FolderOpen, Plus, Rows2, SquareArrowOutUpRight, SquareStack, Terminal as TerminalIcon, X } from "lucide-react";
import { Empty, errorMessage, Menu, tooltipProps, useHostCapabilities, type MenuItem, type PanelProps } from "tau";
import { terminalServices, terminalStore, useTerminalKit } from "./store.js";
import { paneIds, type TerminalGroup } from "./layout.js";
import { closeTerminals, groupPanes, moveTerminalToStage, openTerminal, syncStageTabs, TERMINAL_READ_ONLY, wantsFirstShell } from "./controller.js";
import { groupLabel, PaneTree, shellDirectory, useOpenFolder, type Run } from "./panes.js";
import { chipLabels, tabTitle, threadScope } from "./scope.js";
import type { UiTerminalSession } from "./protocol.js";

export { placeOf, type TerminalPlace } from "./panes.js";

/** Where a menu hangs below its button, over the whole window. */
function below(button: HTMLElement | null): { x: number; y: number } {
  const rect = button?.getBoundingClientRect();
  return rect ? { x: rect.left, y: rect.bottom + 4 } : { x: 0, y: 0 };
}

/** Below this the split buttons fold into the tab bar's menu. */
const NARROW_PANEL = 300;
const ROOMY_PANEL = 640;

export function TerminalPanel({ actions, active, placement }: PanelProps) {
  const { sessions, activeSessionId: switched, layout } = useTerminalKit();
  // The thread on screen, asked on every render: the store's copy only says
  // that it changed, and is empty until the first switch after activation.
  const activeSessionId = actions.activeThread()?.sessionId ?? switched;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // A tab of another thread the user asked to see here, until the thread changes.
  const [picked, setPicked] = useState<{ thread: string | undefined; group: string }>();
  const [menu, setMenu] = useState<"more" | "elsewhere">();
  const [width, setWidth] = useState(0);
  const section = useRef<HTMLElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const elsewhereButton = useRef<HTMLButtonElement>(null);
  const wasActive = useRef(false);
  const { readOnly } = useHostCapabilities();

  const run: Run = (work) => {
    setBusy(true);
    setError("");
    void Promise.resolve().then(work).catch((problem: unknown) => setError(errorMessage(problem))).finally(() => setBusy(false));
  };

  useEffect(() => { terminalServices.actions = actions; }, [actions]);
  useEffect(() => {
    terminalStore.setPanelVisible(active);
    return () => terminalStore.setPanelVisible(false);
  }, [active]);
  // Opening the panel is asking for a terminal: a thread without one gets it.
  useEffect(() => {
    if (active && !wasActive.current && wantsFirstShell(actions)) run(() => openTerminal(actions));
    wasActive.current = active;
  }, [active]);
  // A stage tab closed while nothing drew it had no one to tell the panel.
  useEffect(() => { syncStageTabs(actions); });
  useEffect(() => {
    const element = section.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const byId = (id: string) => sessions.find((session) => session.id === id);
  const pickedGroup = picked && picked.thread === activeSessionId ? picked.group : undefined;
  const scope = threadScope(layout, sessions, activeSessionId, pickedGroup);
  const current = scope.current;
  const target = current?.focused;
  // The panel's commands follow the tab it shows, not one another thread left active.
  useEffect(() => {
    if (current && layout.active !== current.id) terminalStore.updateLayout((next) => ({ ...next, active: current.id }));
  }, [current?.id, layout.active]);
  const onStage = layout.stage.flatMap((group) => paneIds(group.root)).filter((id) => byId(id)).length;
  const tabNames = chipLabels(scope.shown.map((group) => ({ id: group.id, label: tabTitle(groupLabel(group, sessions) ?? "Terminal") })));
  const tabs = useRef<HTMLDivElement>(null);
  // The tab on screen stays in view when the strip scrolls.
  useEffect(() => { tabs.current?.querySelector<HTMLElement>("[aria-selected=true]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [current?.id, scope.shown.length]);
  const focused = target ? byId(target) : undefined;
  const folder = useOpenFolder(focused);
  // Unmeasured (a test, a first frame) counts as wide.
  const narrow = width > 0 && width < NARROW_PANEL;
  // The other threads' button keeps its words where the tabs keep room for theirs.
  const roomy = width === 0 || width >= ROOMY_PANEL;

  const select = (group: TerminalGroup) => {
    terminalStore.updateLayout((next) => ({ ...next, active: group.id }));
    terminalStore.requestFocus(group.focused);
  };
  const newTerminal = () => run(() => openTerminal(actions));
  const split = (direction: "right" | "down") => run(() => openTerminal(actions, { direction, ...(target ? { target } : {}) }));
  const moreItems: MenuItem[] = [
    ...(narrow && !readOnly ? [
      { id: "right", label: "Split right", icon: <Columns2 size={13} />, disabled: !target },
      { id: "down", label: "Split down", icon: <Rows2 size={13} />, disabled: !target },
    ] : []),
    ...(focused ? [{ id: "stage", label: "Open as a stage tab", description: "The shell keeps running", icon: <SquareArrowOutUpRight size={13} /> }] : []),
    ...(folder ? [{ id: "folder", label: folder.label, icon: <FolderOpen size={13} /> }] : []),
  ];
  const pickMore = (id: string) => {
    if (id === "right" || id === "down") split(id);
    else if (id === "stage" && focused) run(() => moveTerminalToStage(actions, focused.id));
    else if (id === "folder") folder?.open();
  };

  // One row of chrome: the tabs, the other threads' shells, and the actions; the dock's maximize button keeps its corner.
  return <section ref={section} className={`panel-body terminal-panel${narrow ? " narrow" : ""}`}>
    <header className="panel-header terminal-toolbar">
      <div ref={tabs} className="terminal-tabs" role="tablist" aria-label="Terminals">
        {scope.shown.map((group) => <TerminalTab
          key={group.id}
          group={group}
          label={tabNames.get(group.id) ?? "Terminal"}
          sessions={sessions}
          selected={group.id === current?.id}
          fromElsewhere={group.id === pickedGroup}
          readOnly={readOnly}
          onSelect={() => select(group)}
          onClose={() => run(() => closeTerminals(groupPanes(group.id)))}
        />)}
        {scope.shown.length === 0 ? <span className="terminal-toolbar-title">Terminal</span> : null}
      </div>
      {scope.elsewhere.length > 0 ? <button
        ref={elsewhereButton}
        type="button"
        className="terminal-elsewhere"
        aria-haspopup="menu"
        aria-expanded={menu === "elsewhere"}
        aria-label={`${scope.elsewhere.length} ${scope.elsewhere.length === 1 ? "shell" : "shells"} in other threads`}
        {...tooltipProps("Shells opened in other threads keep running there. Pick one to show it here.")}
        onClick={() => setMenu("elsewhere")}
      ><SquareStack size={13} aria-hidden="true" /><span>{scope.elsewhere.length}</span>{roomy ? <span>in other threads</span> : null}</button> : null}
      <span className="terminal-panel-actions">
        {readOnly ? null : <button className="icon-button" aria-label="New terminal" {...tooltipProps("New terminal", { shortcut: "⌘N in a terminal" })} disabled={busy} onClick={newTerminal}><Plus size={14} /></button>}
        {readOnly || narrow ? null : <>
          <button className="icon-button" aria-label="Split right" {...tooltipProps("Split right", { shortcut: "⌘D in a terminal" })} disabled={busy || !target} onClick={() => split("right")}><Columns2 size={14} /></button>
          <button className="icon-button" aria-label="Split down" {...tooltipProps("Split down", { shortcut: "⌘⇧D in a terminal" })} disabled={busy || !target} onClick={() => split("down")}><Rows2 size={14} /></button>
        </>}
        {moreItems.length > 0 ? <button ref={moreButton} className="icon-button" aria-label="More terminal actions" aria-haspopup="menu" aria-expanded={menu === "more"} {...tooltipProps("More terminal actions")} disabled={busy} onClick={() => setMenu("more")}><Ellipsis size={14} /></button> : null}
      </span>
    </header>
    {menu === "more" ? <Menu at={below(moreButton.current)} label="Terminal actions" items={moreItems} onSelect={pickMore} onClose={() => setMenu(undefined)} /> : null}
    {readOnly && <p className="terminal-note" role="note">{TERMINAL_READ_ONLY}</p>}
    {menu === "elsewhere" ? <Menu
      at={below(elsewhereButton.current)}
      label="Shells in other threads"
      sections={[{
        heading: "Running in other threads",
        items: scope.elsewhere.map((group) => {
          const first = byId(paneIds(group.root)[0]!);
          const exited = paneIds(group.root).every((id) => byId(id)?.exitCode !== undefined);
          return { id: group.id, label: groupLabel(group, sessions) ?? "Terminal", description: [first ? shellDirectory(first) : undefined, exited ? "exited" : undefined].filter(Boolean).join(" · ") };
        }),
      }]}
      footer={<p className="terminal-menu-note">They stay with their thread. Pick one to show it here.</p>}
      onSelect={(id) => {
        const group = scope.elsewhere.find((entry) => entry.id === id);
        if (!group) return;
        setPicked({ thread: activeSessionId, group: group.id });
        select(group);
      }}
      onClose={() => setMenu(undefined)}
    /> : null}
    {error && <p role="alert" className="terminal-error">{error}</p>}
    {onStage > 0 && current ? <p className="terminal-note">{onStage === 1 ? "One shell is on the stage." : `${onStage} shells are on the stage.`}</p> : null}
    <div className="terminal-surface">
      {current
        ? <PaneTree group={current} sessions={sessions} place="panel" actions={actions} run={run} activeSessionId={activeSessionId} />
        : onStage > 0
          ? <p className="empty-copy">Every shell is on the stage.</p>
          : <Empty
            icon={<TerminalIcon size={20} />}
            title={readOnly ? "No shell is open" : "No terminal in this thread"}
            description={readOnly ? "This device can watch shells the host opens." : "Open one to run commands in this workspace."}
          >
            {readOnly ? null : <button type="button" className="chrome-button" disabled={busy} onClick={newTerminal}><Plus size={13} aria-hidden="true" />Open a terminal</button>}
          </Empty>}
    </div>
  </section>;
}

/** A panel tab: its name selects it, its × ends every shell in it. */
function TerminalTab({ group, label, sessions, selected, fromElsewhere, readOnly, onSelect, onClose }: {
  group: TerminalGroup;
  label: string;
  sessions: readonly UiTerminalSession[];
  selected: boolean;
  fromElsewhere: boolean;
  readOnly: boolean;
  onSelect(): void;
  onClose(): void;
}) {
  const ids = paneIds(group.root);
  const first = sessions.find((session) => session.id === ids[0]);
  const exited = ids.every((id) => sessions.find((session) => session.id === id)?.exitCode !== undefined);
  const where = first ? shellDirectory(first) ?? first.label : label;
  return <div className={`terminal-tab${selected ? " active" : ""}${fromElsewhere ? " elsewhere" : ""}`}>
    <button
      type="button"
      role="tab"
      className="terminal-tab-name"
      aria-selected={selected}
      {...tooltipProps(fromElsewhere ? `${where} · opened in another thread` : where)}
      onClick={onSelect}
    >
      <TerminalIcon size={12} aria-hidden="true" />
      <span className="terminal-tab-label">{label}</span>
      {fromElsewhere ? <span className="terminal-tab-place">other thread</span> : null}
      {exited ? <span className="terminal-tab-place">exited</span> : null}
    </button>
    {readOnly ? null : <button type="button" className="terminal-tab-close" aria-label={`Close tab ${label}`} {...tooltipProps("Close this tab's shells")} onClick={onClose}><X size={12} /></button>}
  </div>;
}
