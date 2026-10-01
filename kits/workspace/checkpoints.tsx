import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  errorMessage,
  hostAvailable,
  hostIsReadOnly,
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
import { turnStatOf } from "./turn-stats.js";
import {
  CHECKPOINT_EVENT,
  WORKSPACE_CHECKPOINT_REVIEW_OVERLAY,
  type CheckpointEvent,
  type WorkspaceCheckpointList,
} from "./protocol.js";
import { RestoreCheckpointDialog } from "./RestoreCheckpointDialog.js";
import { hasTurnChanges, TurnChangesPill } from "./turn-changes.js";
import { createForkAsker, createTurnActions, ForkAsks } from "./turn-actions.js";
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
  /** A negative answer that predates the thread's runtime; ask again. */
  supportStale: boolean;
  /** Bumped whenever the thread's own work may have changed what restores. */
  verifyGeneration: number;
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
  private state: CheckpointState = { persisted: [], restoreSupported: false, supportStale: false, verifyGeneration: 0, live: new Map(), restorable: new Set(), restoreBusy: false };
  private listeners = new Set<() => void>();
  /** Opens the restore dialog for a checkpoint; set while the controller is mounted. */
  onRestore?: (checkpoint: UiTurnCheckpoint) => void;
  getSnapshot = () => this.state;
  /** Every checkpoint of the thread, persisted and announced, oldest first. */
  all(): UiTurnCheckpoint[] { return mergeCheckpoints(this.state.persisted, this.state.live); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update(patch: Partial<CheckpointState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  resetThread(): void {
    this.update({ sessionId: undefined, persisted: [], restoreSupported: false, supportStale: false, live: new Map(), restorable: new Set(), restore: undefined, review: undefined });
  }
  loaded(sessionId: string, list: WorkspaceCheckpointList): void {
    this.update({ sessionId, persisted: list.checkpoints, restoreSupported: list.restoreSupported, supportStale: false });
  }
  /**
   * Both host answers behind a restore control are about a moment: support is
   * read off the thread's live runtime, which a cold start lists before it
   * binds, and a checkpoint is unrestorable while its own capture is pending.
   * Every no is therefore provisional, and this asks for both again.
   */
  revalidate(): void {
    this.update({
      verifyGeneration: this.state.verifyGeneration + 1,
      ...(this.state.sessionId && !this.state.restoreSupported ? { supportStale: true } : {}),
    });
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
 * The region over the composer: the pill of the running or latest turn. It
 * also turns the thread's other checkpoints into transcript rows, verifies
 * which ones restore safely, and hosts the restore dialog.
 */
function createController(store: CheckpointStore, workspaceStore: WorkspaceStore, rows: ReturnType<DesktopExtensionContext["registerTranscriptRows"]>) {
  return function CheckpointController({ snapshot, actions }: RegionProps) {
    const { snapshot: workbenchSnapshot, tools: workbenchTools } = useWorkbench();
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const sessionId = workbenchSnapshot?.sessionId;
    const streaming = Boolean(workbenchSnapshot?.isStreaming);
    const listed = state.sessionId === sessionId;
    const restoreSupported = listed && state.restoreSupported;
    const checkpoints = useMemo(() => mergeCheckpoints(listed ? state.persisted : undefined, state.live), [listed, state.persisted, state.live]);
    const shown = useMemo(() => checkpoints.filter(hasTurnChanges), [checkpoints]);

    // The host lists the thread's checkpoints once per thread; live events add
    // to them. A thread reset (the active-thread event) empties the list, so it
    // is loaded again whenever the store has nothing for the thread on screen,
    // and once more when a run proved the runtime the first answer lacked.
    useEffect(() => {
      if (!sessionId || !hostAvailable() || (listed && !state.supportStale)) return;
      let cancelled = false;
      workspaceStore.host.checkpoints(sessionId)
        .then((list) => {
          if (cancelled) return;
          store.loaded(sessionId, list);
          // The host may have read an old record again; the rail's stat follows it.
          for (const checkpoint of list.checkpoints) workspaceStore.recordTurnStat(sessionId, turnStatOf(checkpoint));
        })
        .catch((error) => { if (!cancelled) actions.notify(errorMessage(error)); });
      return () => { cancelled = true; };
    }, [actions, listed, state.supportStale, sessionId]);

    // A turn that just ended is proof the thread has a runtime, whether or not
    // it recorded a checkpoint. Nothing else tells the renderer that the host
    // would now answer differently.
    const ran = useRef(false);
    useEffect(() => {
      if (streaming) { ran.current = true; return; }
      if (!ran.current) return;
      ran.current = false;
      store.revalidate();
    }, [streaming]);

    useEffect(() => {
      if (!state.notice) return;
      actions.notify(state.notice);
      store.update({ notice: undefined });
    }, [actions, state.notice]);

    // Verify restorability per thread, checkpoint set and revalidation; the host
    // checks refs and workspace, and refuses while the thread or a capture of it
    // is still working. The checkpoint of a turn is announced from inside that
    // capture, so the first answer for a fresh pill is always no.
    useEffect(() => {
      if (!sessionId || !restoreSupported || streaming || !hostAvailable()) { store.update({ restorable: new Set() }); return; }
      let cancelled = false;
      void Promise.all(shown.map(async (checkpoint) => {
        if (checkpoint.completeness === "partial") return undefined;
        try { return await workspaceStore.host.canRestoreCheckpoint(sessionId, checkpoint.id) ? checkpoint.id : undefined; }
        catch { return undefined; }
      })).then((ids) => {
        if (!cancelled) store.update({ restorable: new Set(ids.filter((id): id is string => Boolean(id))) });
      });
      return () => { cancelled = true; };
    }, [sessionId, restoreSupported, shown, streaming, state.verifyGeneration]);

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

    useEffect(() => {
      store.onRestore = (checkpoint) => void requestRestore(checkpoint);
      return () => { store.onRestore = undefined; };
    }, [requestRestore]);

    const confirmRestore = useCallback(async (files: boolean) => {
      const request = store.getSnapshot().restore;
      if (!request || !sessionId) return;
      if (streaming) { store.update({ restore: undefined }); actions.notify("The turn started before the rewind was confirmed. No changes were made."); return; }
      store.update({ restoreBusy: true });
      if (files) actions.notify("Creating a restore backup…");
      try {
        if (files) {
          actions.applyHostResult(await workspaceStore.host.restoreCheckpoint(sessionId, request.checkpoint.id));
          store.update({ restore: undefined });
          actions.notify("Rewound with files. The previous conversation and workspace are available in the backup thread.");
        } else {
          actions.applyHostResult(await workspaceStore.host.rewindCheckpoint(sessionId, request.checkpoint.id));
          store.update({ restore: undefined });
          actions.notify("Rewound the conversation; files were kept. The previous branch stays in its own thread.");
        }
      } catch (error) {
        actions.notify(errorMessage(error));
      } finally {
        store.update({ restoreBusy: false });
      }
    }, [actions, sessionId, streaming]);

    // The running turn's files so far, while it has any; its checkpoint replaces them when it ends.
    const kit = useSyncExternalStore(workspaceStore.subscribe, workspaceStore.getSnapshot, workspaceStore.getSnapshot);
    const liveChanges = useMemo(() => workspaceStore.turnChanges(workbenchTools), [kit.changes, kit.turnBaseline, workbenchTools]);
    const live = !kit.draftPending && !kit.turnSettled && streaming && liveChanges.files.length > 0;
    // Above the composer: the running turn, else the latest turn that changed something.
    const latest = live ? undefined : shown.at(-1);

    const pillProps = useCallback((checkpoint: UiTurnCheckpoint) => ({
      changes: checkpoint,
      onOpenDiff: (path?: string) => { store.update({ review: { checkpoint, path } }); actions.openOverlay(CHECKPOINT_REVIEW_OVERLAY); },
      onRestore: restoreSupported && checkpoint.completeness !== "partial" && state.restorable.has(checkpoint.id) && !streaming && !hostIsReadOnly()
        ? () => void requestRestore(checkpoint)
        : undefined,
      loadFiles: hostAvailable() ? (cursor?: string, limit?: number) => workspaceStore.host.getTurnFiles(checkpoint.sessionId, checkpoint.id, cursor, limit) : undefined,
    }), [actions, requestRestore, restoreSupported, state.restorable, streaming]);

    // Rows: every other turn keeps a pill where its answer is, so it can still be read and rewound.
    useEffect(() => {
      if (!sessionId) return;
      const list: TranscriptRow[] = shown.filter((checkpoint) => checkpoint !== latest).map((checkpoint) => ({
        id: checkpoint.id,
        afterMessageId: checkpoint.anchorMessageId,
        content: <div className="turn-checkpoint-row" data-checkpoint-id={checkpoint.id}><TurnChangesPill {...pillProps(checkpoint)} side="bottom" /></div>,
      }));
      rows.setRows(sessionId, list);
    }, [shown, latest, pillProps, sessionId]);

    void snapshot;
    return (
      <>
        {sessionId && (live || latest) ? <div className="turn-changes-bar">
          {latest
            ? <TurnChangesPill key={latest.id} {...pillProps(latest)} />
            : <TurnChangesPill key="live" live changes={liveChanges} onOpenDiff={(path) => workspaceStore.openReview(path)} />}
        </div> : null}
        {state.restore ? <RestoreCheckpointDialog
          checkpoint={state.restore.checkpoint}
          laterTurns={state.restore.laterTurns}
          workspaceChanges={state.restore.workspaceChanges}
          busy={state.restoreBusy}
          onCancel={() => { if (!store.getSnapshot().restoreBusy) store.update({ restore: undefined }); }}
          onConfirm={(files) => void confirmRestore(files)}
        /> : null}
      </>
    );
  };
}

/** Read-only review of one immutable turn, opened from its pill. */
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
  const rows = plugin.registerTranscriptRows("checkpoints", 20, { profiles: ["desktop", "compact"] });
  plugin.events.on("active-thread-changed", () => store.resetThread());
  plugin.host.onEvent(CHECKPOINT_EVENT, (payload) => {
    const event = payload as CheckpointEvent;
    // Only the pill is drawn from the announcement: the capture that emits it
    // still holds the turn, so nothing about restoring it is answerable yet.
    if (event?.type === "turn-checkpoint") {
      workspaceStore.recordTurnStat(event.sessionId, turnStatOf(event.checkpoint));
      // The pill drawn from this announcement takes over from the live one,
      // which hid itself when the turn settled, so the same changes are never drawn twice.
      store.announce(event.checkpoint);
    }
    // The capture briefly waits for the workspace lease before Pi starts; say so in place of the spinner.
    else if (event?.type === "turn-checkpoint-status") {
      plugin.setLiveStatus(event.sessionId, event.status === "queued" || event.status === "waiting" ? "Waiting for workspace…" : undefined);
      // The capture is over: the thread has a runtime and holds nothing, which
      // is exactly what the two host answers behind a restore control need.
      if (event.status === "released") store.revalidate();
      if (event.status === "skipped") {
        const notice = workspaceStore.skippedCheckpointNotice(event.sessionId);
        if (notice) store.update({ notice });
      }
    } else if (event?.type === "turn-checkpoint-error") store.update({ notice: event.message });
  });
  plugin.registerRegion({ id: "workspace.checkpoints", placement: "composer-controls", order: 70, profiles: ["desktop", "compact"], Component: createController(store, workspaceStore, rows) });
  plugin.registerRegion({ id: "workspace.turn-actions", placement: "turn-divider", profiles: ["desktop"], Component: createTurnActions(store, workspaceStore, false) });
  plugin.registerRegion({ id: "workspace.turn-actions-touch", placement: "turn-divider", profiles: ["compact"], Component: createTurnActions(store, workspaceStore, true) });
  // Every other fork (`f`, the thread tree, Duplicate) asks the same question.
  const asks = new ForkAsks();
  plugin.registerForkPrompt({ id: "workspace.fork", ask: (request) => asks.set(request) });
  plugin.registerRegion({ id: "workspace.fork", placement: "composer-controls", profiles: ["desktop"], Component: createForkAsker(asks, store, workspaceStore, false) });
  plugin.registerRegion({ id: "workspace.fork-touch", placement: "composer-controls", profiles: ["compact"], Component: createForkAsker(asks, store, workspaceStore, true) });
  plugin.registerOverlay({ id: CHECKPOINT_REVIEW_OVERLAY, profiles: ["desktop", "compact"], Component: createReviewOverlay(store, workspaceStore) });
}

export type { WorkbenchActions };
