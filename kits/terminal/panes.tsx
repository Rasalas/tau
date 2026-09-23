import { Fragment, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from "react";
import { FolderOpen } from "lucide-react";
import type { WorkbenchActions } from "tau";
import { TerminalView } from "./view.js";
import { terminalServices, terminalStore } from "./store.js";
import { moveDivider, paneIds, resizeGroupSplit, splitShares, type PaneNode, type TerminalGroup } from "./layout.js";
import { closeTerminals, moveTerminalToStage, restartTerminal } from "./controller.js";
import type { UiTerminalSession, WorkspaceStoreMirror } from "./protocol.js";

/** Where a terminal sits relative to the thread on screen; the panel marks the ones that are not here. */
export type TerminalPlace = "thread" | "project" | "elsewhere";

export function placeOf(session: UiTerminalSession, activeSessionId: string | undefined): TerminalPlace {
  if (!session.sessionId) return "project";
  return session.sessionId === activeSessionId ? "thread" : "elsewhere";
}

export const PLACE_LABEL: Record<TerminalPlace, string> = {
  thread: "this thread",
  project: "project",
  elsewhere: "another thread",
};

/** The directory a shell is in now, as far as anyone knows. */
export function shellDirectory(session: UiTerminalSession): string | undefined {
  return session.currentCwd ?? session.cwd;
}

/** `path` relative to `root` with forward slashes, `""` for the root itself, or `undefined` when it lies outside. */
export function pathInside(root: string, path: string): string | undefined {
  const trim = (value: string) => value.length > 1 ? value.replace(/[\\/]+$/u, "") : value;
  const base = trim(root);
  const target = trim(path);
  if (target === base) return "";
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  const prefix = base.endsWith(separator) ? base : `${base}${separator}`;
  return target.startsWith(prefix) ? target.slice(prefix.length).split(separator).join("/") : undefined;
}

/** A tab's name: its first shell's, and how many more it holds. */
export function groupLabel(group: TerminalGroup, sessions: readonly UiTerminalSession[]): string | undefined {
  const ids = paneIds(group.root);
  const first = sessions.find((session) => session.id === ids[0]);
  if (!first) return undefined;
  return ids.length > 1 ? `${first.label} +${ids.length - 1}` : first.label;
}

const noSubscription = () => () => undefined;
const noSnapshot = () => undefined;

/**
 * Opens the shell's directory the way the title bar's "Open in" opens the
 * project, through Workspace Kit's store; only for a directory inside the
 * project that store follows.
 */
function OpenFolderButton({ session, workspace }: { session: UiTerminalSession; workspace: WorkspaceStoreMirror }) {
  // The snapshot only says when the editors or the followed project changed.
  const state = useSyncExternalStore(workspace.subscribe ?? noSubscription, workspace.getSnapshot ?? noSnapshot);
  const directory = shellDirectory(session);
  const editor = workspace.activeEditor?.();
  const root = state?.cwd;
  const relative = directory && root ? pathInside(root, directory) : undefined;
  if (!editor || relative === undefined || !workspace.openInEditor) return null;
  const name = relative ? relative.split("/").at(-1) : "the project";
  return <button
    type="button"
    className="text-button"
    aria-label={`Open ${name} in ${editor.name}`}
    title={`Open ${directory} in ${editor.name}`}
    onClick={() => void workspace.openInEditor?.(relative || undefined)}
  ><FolderOpen size={12} /></button>;
}

export type Run = (work: () => Promise<unknown> | unknown) => void;

export interface PaneTreeProps {
  group: TerminalGroup;
  sessions: readonly UiTerminalSession[];
  /** The panel's tabs or a stage tab; a staged pane has nowhere further to move. */
  place: "panel" | "stage";
  actions: WorkbenchActions | undefined;
  run: Run;
  activeSessionId: string | undefined;
}

function Pane({ session, split, group, place, actions, run, activeSessionId }: Omit<PaneTreeProps, "sessions"> & { session: UiTerminalSession; split: boolean }) {
  const where = placeOf(session, activeSessionId);
  const exited = session.exitCode !== undefined;
  const directory = shellDirectory(session);
  const workspace = terminalServices.workspace;
  return <section className="terminal-pane" aria-label={session.label}>
    <header className="terminal-pane-header">
      <span className="terminal-pane-title" title={directory ?? session.label}>{split ? session.label : directory ?? session.label}</span>
      {where === "elsewhere" && <span className="terminal-tab-place">{PLACE_LABEL[where]}</span>}
      {exited && <>
        <span className="terminal-pane-exit">shell exited with {session.exitCode}</span>
        <button type="button" className="text-button" onClick={() => run(() => restartTerminal(session.id))}>Restart shell</button>
      </>}
      <span className="terminal-pane-actions">
        {workspace ? <OpenFolderButton session={session} workspace={workspace} /> : null}
        {place === "panel" && actions ? <button
          type="button"
          className="text-button"
          aria-label={`Open ${session.label} as tab`}
          title="Move this shell to the stage; it keeps running"
          onClick={() => run(() => moveTerminalToStage(actions, session.id))}
        >↗</button> : null}
        <button type="button" className="text-button" aria-label={`Close ${session.label}`} title={place === "panel" ? "Close this shell (⌘W)" : "Close this shell"} onClick={() => run(() => closeTerminals([session.id]))}>×</button>
      </span>
    </header>
    <TerminalView session={session} place={place} focused={split && group.focused === session.id} />
  </section>;
}

const KEY_STEP = 0.05;

/**
 * A split's children with a divider between each two: drag it, or focus it
 * and use the arrow keys; a double click shares the length evenly again. The
 * shares are drawn from a draft while dragging and stored once on release.
 */
function SplitView({ node, path, ...rest }: PaneTreeProps & { node: Extract<PaneNode, { kind: "split" }>; path: number[] }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; index: number; start: number; length: number; initial: number[]; latest: number[] } | undefined>(undefined);
  const [draft, setDraft] = useState<number[] | undefined>(undefined);
  const stored = splitShares(node);
  const shares = draft?.length === stored.length ? draft : stored;
  const across = node.direction === "right";
  const commit = (sizes: number[]) => terminalStore.updateLayout((layout) => resizeGroupSplit(layout, rest.group.id, path, sizes));
  const coordinate = (event: PointerEvent) => across ? event.clientX : event.clientY;

  const onPointerDown = (index: number) => (event: PointerEvent<HTMLDivElement>) => {
    const element = box.current;
    if (event.button !== 0 || !element) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rect = element.getBoundingClientRect();
    drag.current = { pointer: event.pointerId, index, start: coordinate(event), length: (across ? rect.width : rect.height) || 1, initial: shares, latest: shares };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    state.latest = moveDivider(state.initial, state.index, (coordinate(event) - state.start) / state.length);
    setDraft(state.latest);
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointer !== event.pointerId) return;
    drag.current = undefined;
    setDraft(undefined);
    const moved = moveDivider(state.initial, state.index, (coordinate(event) - state.start) / state.length);
    const latest = event.type === "pointercancel" ? state.latest : moved;
    if (latest.some((share, index) => share !== state.initial[index])) commit(latest);
  };
  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLDivElement>) => {
    const back = across ? "ArrowLeft" : "ArrowUp";
    const forward = across ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    commit(moveDivider(shares, index, event.key === forward ? KEY_STEP : -KEY_STEP));
  };

  return <div ref={box} className={`terminal-split terminal-split-${node.direction}${draft ? " resizing" : ""}`}>
    {node.children.map((child, index) => <Fragment key={paneIds(child).join(":")}>
      {index > 0 && <div
        role="separator"
        tabIndex={0}
        className="terminal-split-handle"
        aria-orientation={across ? "vertical" : "horizontal"}
        aria-label="Resize terminals"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shares.slice(0, index).reduce((sum, share) => sum + share, 0) * 100)}
        title="Drag to resize; double-click to share evenly"
        onPointerDown={onPointerDown(index)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown(index)}
        onDoubleClick={() => commit(node.children.map(() => 1 / node.children.length))}
      />}
      <div className="terminal-split-cell" style={{ flexGrow: shares[index] }}>
        <PaneNodeView node={child} path={[...path, index]} {...rest} />
      </div>
    </Fragment>)}
  </div>;
}

function PaneNodeView({ node, path, ...rest }: PaneTreeProps & { node: PaneNode; path: number[] }) {
  if (node.kind === "split") return <SplitView node={node} path={path} {...rest} />;
  const session = rest.sessions.find((entry) => entry.id === node.id);
  return session ? <Pane session={session} split={rest.group.root.kind === "split"} {...rest} /> : null;
}

/** One tab's shells, panel or stage, in the tree the user split them into. */
export function PaneTree(props: PaneTreeProps) {
  return <PaneNodeView node={props.group.root} path={[]} {...props} />;
}
