import { useEffect, useSyncExternalStore, type ComponentType } from "react";
import { Server } from "lucide-react";
import { tooltipProps, type RegionProps, type UiSession, type WorkbenchActions } from "tau";
import { STATE_LABELS, STATE_TONES, statusSentence, worstState } from "./status-model.js";
import type { ServersStatusStore, StatusEntry } from "./status-store.js";
import { SERVER_TARGET_TAB, type ServerSyncState, type TargetStatus } from "./view-protocol.js";

/** The slice of Workspace Kit's store (`tau.workspace/store`) the server surfaces use; a kit never imports another. */
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";
export interface WorkspaceStoreSlice {
  getSnapshot(): { cwd?: string; changes?: unknown };
  subscribe(listener: () => void): () => void;
  registerChangesSection(section: ComponentType<{ actions: WorkbenchActions }>): () => void;
  registerThreadRowAccessory(accessory: ComponentType<{ session: UiSession }>): () => void;
  registerRailSection?(section: ComponentType<{ actions: WorkbenchActions }>): () => void;
}

export interface TargetTabParams extends Record<string, unknown> {
  workspace: string;
  targetId: string;
}

export function openTarget(actions: Pick<WorkbenchActions, "openStageTab">, workspace: string, targetId: string): string {
  const params: TargetTabParams = { workspace, targetId };
  return actions.openStageTab(SERVER_TARGET_TAB, params);
}

export function useServersStatus(store: ServersStatusStore, cwd: string | undefined): StatusEntry {
  const entry = useSyncExternalStore(store.subscribe, () => store.get(cwd));
  useEffect(() => { store.ensure(cwd); }, [store, cwd]);
  return entry;
}

export function StatusDot({ state, checking = false }: { state: ServerSyncState; checking?: boolean }) {
  return <span className={`servers-dot tone-${STATE_TONES[state]}${checking ? " checking" : ""}`} aria-hidden="true" />;
}

/** The target a click on the project's mark opens: the one in the worst state. */
export function worstTarget(targets: readonly TargetStatus[]): TargetStatus | undefined {
  const state = worstState(targets.map((target) => target.state));
  return targets.find((target) => target.state === state);
}

export const targetTooltip = (target: TargetStatus) => `${target.label}: ${STATE_LABELS[target.state]}\n${statusSentence(target)}`;

/** Title bar: a server glyph with the project's worst state as a dot, the targets in its tooltip. */
export function createTitleChip(store: ServersStatusStore) {
  return function ServersTitleChip({ snapshot, actions }: RegionProps) {
    const cwd = snapshot?.cwd;
    const { status } = useServersStatus(store, cwd);
    const targets = status?.targets ?? [];
    const target = worstTarget(targets);
    if (!status || !target) return null;
    const pending = targets.reduce((sum, entry) => sum + entry.pendingTotal, 0);
    const checking = targets.some((entry) => entry.checking);
    return (
      <button
        type="button"
        className="chrome-ghost servers-chip"
        aria-label={`Servers: ${STATE_LABELS[target.state]}`}
        {...tooltipProps(targets.map(targetTooltip).join("\n\n"), { side: "bottom", variant: "lines" })}
        onClick={() => openTarget(actions, status.workspace, target.targetId)}
      >
        <Server size={14} aria-hidden="true" />
        <StatusDot state={target.state} checking={checking} />
        {pending > 0 ? <span className="servers-chip-count">{pending}</span> : null}
      </button>
    );
  };
}

function useFollowedCwd(workspace: () => WorkspaceStoreSlice | undefined): string | undefined {
  const store = workspace();
  return useSyncExternalStore(store?.subscribe ?? noSubscription, () => store?.getSnapshot().cwd);
}
const noSubscription = () => () => undefined;

/** Top of the Changes panel: what the followed project's servers lack or changed. */
export function createChangesSection(store: ServersStatusStore, workspace: () => WorkspaceStoreSlice | undefined) {
  return function ServersChangesSection({ actions }: { actions: WorkbenchActions }) {
    const cwd = useFollowedCwd(workspace);
    const { status } = useServersStatus(store, cwd);
    const shown = (status?.targets ?? []).filter((target) => target.state !== "in-sync" && target.state !== "never-read" && target.state !== "unusable");
    if (!status || shown.length === 0) return null;
    return (
      <section className="servers-changes" aria-label="Servers">
        {shown.map((target) => (
          <div key={target.targetId} className="servers-changes-row">
            <StatusDot state={target.state} checking={target.checking} />
            <span className="servers-changes-text"><strong>Server {target.label}:</strong> {statusSentence(target)}</span>
            <button type="button" className="text-button" onClick={() => openTarget(actions, status.workspace, target.targetId)}>Review…</button>
          </div>
        ))}
      </section>
    );
  };
}

/** Foot of the rail: the followed project's targets with their state. */
export function createRailSection(store: ServersStatusStore, workspace: () => WorkspaceStoreSlice | undefined) {
  return function ServersRailSection({ actions }: { actions: WorkbenchActions }) {
    const cwd = useFollowedCwd(workspace);
    const { status } = useServersStatus(store, cwd);
    const targets = status?.targets ?? [];
    if (!status || targets.length === 0) return null;
    return (
      <section className="servers-rail" aria-label="Servers">
        <div className="servers-rail-head">Servers</div>
        {targets.map((target) => (
          <button
            key={target.targetId}
            type="button"
            className="servers-rail-row"
            {...tooltipProps(`${target.address}\n${statusSentence(target)}`, { side: "right", variant: "lines" })}
            onClick={() => openTarget(actions, status.workspace, target.targetId)}
          >
            <StatusDot state={target.state} checking={target.checking} />
            <span className="servers-rail-label">{target.label}</span>
            <span className="servers-rail-state">{target.pendingTotal > 0 && target.state === "pending" ? `${target.pendingTotal} not uploaded` : STATE_LABELS[target.state]}</span>
          </button>
        ))}
      </section>
    );
  };
}

/** A rail row's mark: the thread deployed to a server and the deployment is not committed yet. */
export function createRowMark(store: ServersStatusStore) {
  return function ServersRowMark({ session }: { session: UiSession }) {
    const marked = useSyncExternalStore(store.subscribe, () => store.deployedUncommitted(session.projectPath, session.id));
    if (!marked) return null;
    const text = `Deployed to ${marked}, not committed yet`;
    return <span className="servers-row-mark" role="img" aria-label={text} {...tooltipProps(text)}><Server size={11} aria-hidden="true" /></span>;
  };
}
