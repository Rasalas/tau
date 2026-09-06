import { lazy, Suspense, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  errorMessage,
  hostAvailable,
  loadReviewMode,
  useWorkbench,
  type DesktopExtensionContext,
  type DiffLoadOptions,
  type OverlayProps,
  type RegionProps,
  type TranscriptRow,
  type UiWorkspaceChanges,
  type WorkbenchActions,
} from "tau";
import type { UiTurnCheckpoint } from "./turn-checkpoint-types.js";
import {
  CHECKPOINT_EVENT,
  WORKSPACE_CHECKPOINT_REVIEW_OVERLAY,
  type CheckpointEvent,
  type WorkspaceCheckpointList,
} from "./protocol.js";
import { RestoreCheckpointDialog } from "./RestoreCheckpointDialog.js";
import { WorkspaceCheckpointCard } from "./checkpoint-card.js";
import type { WorkspaceStore } from "./store.js";

const LazyReview = lazy(() => loadReviewMode().then((ReviewMode) => ({ default: ReviewMode })));

export const CHECKPOINT_REVIEW_OVERLAY = WORKSPACE_CHECKPOINT_REVIEW_OVERLAY;

interface RestoreRequest {
  checkpoint: UiTurnCheckpoint;
  laterTurns: number;
  workspaceChanges: UiWorkspaceChanges;
}

interface CheckpointState {
  /** The thread whose checkpoints were loaded from the host. */
  sessionId?: string;
  /** Every checkpoint of the thread's branch, as the host last listed them. */
  persisted: readonly UiTurnCheckpoint[];
  /** Whether the host can restore one of them for this thread. */
  restoreSupported: boolean;
  /** Checkpoints announced live for the thread on screen, keyed by id. */
  live: Map<string, UiTurnCheckpoint>;
  restorable: ReadonlySet<string>;
  restore?: RestoreRequest;
  restoreBusy: boolean;
  review?: { checkpoint: UiTurnCheckpoint; path?: string };
  /** A capture failure the host reported; shown once. */
  notice?: string;
}

/** The kit's own checkpoint state; App knows none of it. */
export class CheckpointStore {
  private state: CheckpointState = { persisted: [], restoreSupported: false, live: new Map(), restorable: new Set(), restoreBusy: false };
  private listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update(patch: Partial<CheckpointState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  resetThread(): void {
    this.update({ sessionId: undefined, persisted: [], restoreSupported: false, live: new Map(), restorable: new Set(), restore: undefined, review: undefined });
  }
  loaded(sessionId: string, list: WorkspaceCheckpointList): void {
    this.update({ sessionId, persisted: list.checkpoints, restoreSupported: list.restoreSupported });
  }
  announce(checkpoint: UiTurnCheckpoint): void {
    const live = new Map(this.state.live);
    live.set(checkpoint.id, checkpoint);
    this.update({ live });
  }
}

function mergeCheckpoints(persisted: readonly UiTurnCheckpoint[] | undefined, live: Map<string, UiTurnCheckpoint>): UiTurnCheckpoint[] {
  const byId = new Map<string, UiTurnCheckpoint>();
  for (const checkpoint of persisted ?? []) byId.set(checkpoint.id, checkpoint);
  for (const checkpoint of live.values()) byId.set(checkpoint.id, checkpoint);
  return [...byId.values()].sort((left, right) => left.endedAt - right.endedAt);
}

/**
 * Invisible region that turns the thread's checkpoints into transcript rows,
 * verifies which ones restore safely, and hosts the restore dialog.
 */
function createController(store: CheckpointStore, workspaceStore: WorkspaceStore, rows: ReturnType<DesktopExtensionContext["registerTranscriptRows"]>) {
  return function CheckpointController({ snapshot, actions }: RegionProps) {
    const { snapshot: workbenchSnapshot } = useWorkbench();
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const sessionId = workbenchSnapshot?.sessionId;
    const streaming = Boolean(workbenchSnapshot?.isStreaming);
    const loaded = state.sessionId === sessionId;
    const restoreSupported = loaded && state.restoreSupported;
    const checkpoints = useMemo(() => mergeCheckpoints(loaded ? state.persisted : undefined, state.live), [loaded, state.persisted, state.live]);

    // The host lists the thread's checkpoints once per thread; live events add
    // to them. A thread reset (the active-thread event) empties the list, so it
    // is loaded again whenever the store has nothing for the thread on screen.
    useEffect(() => {
      if (!sessionId || !hostAvailable() || loaded) return;
      let cancelled = false;
      workspaceStore.host.checkpoints(sessionId)
        .then((list) => { if (!cancelled) store.loaded(sessionId, list); })
        .catch((error) => { if (!cancelled) actions.notify(errorMessage(error)); });
      return () => { cancelled = true; };
    }, [actions, loaded, sessionId]);

    useEffect(() => {
      if (!state.notice) return;
      actions.notify(state.notice);
      store.update({ notice: undefined });
    }, [actions, state.notice]);

    // Verify restorability once per thread and checkpoint set; the host checks refs and workspace.
    useEffect(() => {
      if (!sessionId || !restoreSupported || !hostAvailable()) { store.update({ restorable: new Set() }); return; }
      let cancelled = false;
      void Promise.all(checkpoints.map(async (checkpoint) => {
        if (checkpoint.completeness === "partial") return undefined;
        try { return await workspaceStore.host.canRestoreCheckpoint(sessionId, checkpoint.id) ? checkpoint.id : undefined; }
        catch { return undefined; }
      })).then((ids) => {
        if (!cancelled) store.update({ restorable: new Set(ids.filter((id): id is string => Boolean(id))) });
      });
      return () => { cancelled = true; };
    }, [sessionId, restoreSupported, checkpoints]);

    const requestRestore = useCallback(async (checkpoint: UiTurnCheckpoint) => {
      if (checkpoint.completeness === "partial") { actions.notify("This checkpoint is incomplete and cannot be restored safely. Use Fork instead."); return; }
      if (streaming) { actions.notify("Wait for the active turn to finish before restoring a checkpoint."); return; }
      if (!restoreSupported) { actions.notify("Restore is unavailable for this runtime. Use Fork to keep the current workspace unchanged."); return; }
      if (!state.restorable.has(checkpoint.id)) { actions.notify("This checkpoint could not be verified and is not available for restore. Use Fork instead."); return; }
      if (!sessionId) return;
      store.update({ restoreBusy: true });
      actions.notify("Verifying checkpoint and workspace…");
      try {
        const workspaceChanges = await workspaceStore.host.getRestorePreview(sessionId, checkpoint.id);
        store.update({
          restore: {
            checkpoint,
            laterTurns: checkpoints.filter((entry) => entry.endedAt > checkpoint.endedAt).length,
            workspaceChanges: { ...workspaceChanges, files: workspaceChanges.files.map((file) => ({ ...file })) },
          },
        });
      } catch (error) {
        actions.notify(errorMessage(error));
      } finally {
        store.update({ restoreBusy: false });
      }
    }, [actions, checkpoints, restoreSupported, sessionId, state.restorable, streaming]);

    const confirmRestore = useCallback(async () => {
      const request = store.getSnapshot().restore;
      if (!request || !sessionId) return;
      if (streaming) { store.update({ restore: undefined }); actions.notify("The turn started before restore was confirmed. No changes were made."); return; }
      store.update({ restoreBusy: true });
      actions.notify("Creating a restore backup…");
      try {
        actions.applyHostResult(await workspaceStore.host.restoreCheckpoint(sessionId, request.checkpoint.id));
        store.update({ restore: undefined });
        actions.notify("Restored checkpoint. The previous conversation and workspace are available in the backup thread.");
      } catch (error) {
        actions.notify(errorMessage(error));
      } finally {
        store.update({ restoreBusy: false });
      }
    }, [actions, sessionId, streaming]);

    // Rows: one card per checkpoint whose anchor the transcript can place.
    useEffect(() => {
      if (!sessionId) return;
      const visible = checkpoints.filter((checkpoint) => checkpoint.completeness === "partial"
        || (checkpoint.fileCount ?? checkpoint.files.length) > 0
        || restoreSupported);
      const list: TranscriptRow[] = visible.map((checkpoint) => ({
        id: checkpoint.id,
        afterMessageId: checkpoint.anchorMessageId,
        content: (
          <WorkspaceCheckpointCard
            checkpoint={checkpoint}
            onOpenDiff={(path) => { store.update({ review: { checkpoint, path } }); actions.openOverlay(CHECKPOINT_REVIEW_OVERLAY); }}
            onRestore={restoreSupported && checkpoint.completeness !== "partial" && state.restorable.has(checkpoint.id) && !streaming
              ? () => void requestRestore(checkpoint)
              : undefined}
            loadFiles={hostAvailable() ? (cursor, limit) => workspaceStore.host.getTurnFiles(checkpoint.sessionId, checkpoint.id, cursor, limit) : undefined}
          />
        ),
      }));
      rows.setRows(sessionId, list);
    }, [actions, checkpoints, requestRestore, restoreSupported, sessionId, state.restorable, streaming]);

    void snapshot;
    if (!state.restore) return null;
    return (
      <RestoreCheckpointDialog
        checkpoint={state.restore.checkpoint}
        laterTurns={state.restore.laterTurns}
        workspaceChanges={state.restore.workspaceChanges}
        busy={state.restoreBusy}
        onCancel={() => { if (!store.getSnapshot().restoreBusy) store.update({ restore: undefined }); }}
        onConfirm={() => void confirmRestore()}
      />
    );
  };
}

/** Read-only review of one immutable turn, opened from a checkpoint card. */
function createReviewOverlay(store: CheckpointStore, workspaceStore: WorkspaceStore) {
  return function CheckpointReviewOverlay({ onClose }: OverlayProps) {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const [path, setPath] = useState(state.review?.path);
    const review = state.review;
    useEffect(() => { setPath(review?.path ?? review?.checkpoint.files[0]?.path); }, [review]);
    if (!review) return null;
    const { checkpoint } = review;
    const loadDiff = (filePath: string, options?: DiffLoadOptions) => hostAvailable()
      ? workspaceStore.host.getTurnFileDiff(checkpoint.sessionId, checkpoint.id, filePath, options)
      : Promise.resolve({ path: filePath, added: 0, removed: 0, hunks: [], note: "Diffs require the Electron host." });
    return (
      <Suspense fallback={null}>
        <LazyReview
          changes={checkpoint}
          selectedPath={path}
          busy={false}
          primaryPush={false}
          onSelect={setPath}
          onBack={() => { store.update({ review: undefined }); onClose(); }}
          onCommit={() => undefined}
          onOpenInEditor={() => undefined}
          readOnly
          checkpointTitle="Turn changes"
          loadDiff={loadDiff}
          loadFiles={hostAvailable() ? (cursor, limit) => workspaceStore.host.getTurnFiles(checkpoint.sessionId, checkpoint.id, cursor, limit) : undefined}
        />
      </Suspense>
    );
  };
}

/** Wires checkpoint rows, live updates, the restore dialog and the review overlay into the kit. */
export function registerCheckpoints(plugin: DesktopExtensionContext, workspaceStore: WorkspaceStore): void {
  const store = new CheckpointStore();
  const rows = plugin.registerTranscriptRows("checkpoints", 20);
  plugin.events.on("active-thread-changed", () => store.resetThread());
  plugin.host.onEvent(CHECKPOINT_EVENT, (payload) => {
    const event = payload as CheckpointEvent;
    if (event?.type === "turn-checkpoint") { store.announce(event.checkpoint); workspaceStore.checkpointRecorded(event.sessionId); }
    // The capture briefly waits for the workspace lease before Pi starts; say so in place of the spinner.
    else if (event?.type === "turn-checkpoint-status") {
      plugin.setLiveStatus(event.sessionId, event.status === "queued" || event.status === "waiting" ? "Waiting for workspace…" : undefined);
      if (event.status === "skipped") store.update({ notice: "Turn changes were not recorded: another turn is active in this workspace." });
    } else if (event?.type === "turn-checkpoint-error") store.update({ notice: event.message });
  });
  plugin.registerRegion({ id: "workspace.checkpoints", placement: "transcript-header", order: 100, Component: createController(store, workspaceStore, rows) });
  plugin.registerOverlay({ id: CHECKPOINT_REVIEW_OVERLAY, Component: createReviewOverlay(store, workspaceStore) });
}

export type { WorkbenchActions };
