import type {
  HostBootstrap,
  HostSnapshot,
  NewThreadRequestId,
  SubmissionResult,
  ThreadBackendKind,
  UiModel,
  UiRuntimeBackend,
} from "../shared/contracts.js";
import {
  HOST_PROTOCOL_VERSION,
  catalogFromSnapshot,
  detailFromSnapshot,
  type HostActionResult,
  type HostCatalog,
  type HostUpdate,
  type NewThreadResult,
  type ProjectMetadata,
  type ThreadDetail,
  type TranscriptPage,
} from "../shared/host-protocol.js";
import type { HostTranscriptCursor } from "../shared/transcript-cursor.js";
import { localTranscriptCursorPolicy, localTranscriptPage } from "./host-transcript.js";
import { clientTranscript } from "./client-tool-output.js";
import { ThreadDetailStore } from "../shared/thread-detail-store.js";
import { runtimeBackendMarks, sortByRuntimeOrder, type HostRuntimeBackendProvider } from "./host-extensions.js";
import type { HostCompletions } from "./host-completion.js";
import type { ProjectFactsCache } from "./project-facts-cache.js";
import { RuntimeResourceCache } from "./runtime-resource-cache.js";
import { RuntimeVersions } from "./runtime-versions.js";
import { isLocalPiRuntime, type ThreadRuntime } from "./thread-runtime.js";
import type { ThreadIndex } from "./thread-index.js";
import type { ThreadProjection } from "./thread-projection.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";
import type { HostLifecycleInstrumentation } from "./host-lifecycle.js";

/** What is on screen; the host moves these pointers on every activation, so they are read per call. */
export interface HostView {
  active(): ThreadRuntime | undefined;
  cwd(): string;
  extensionCount(): number;
}

export interface HostPublicationDeps {
  index: ThreadIndex;
  workspaces: WorkspaceIdentity;
  metrics: HostLifecycleInstrumentation;
  emitUpdate(update: HostUpdate): void;
  view: HostView;
  projection: Pick<ThreadProjection, "hostSnapshot" | "catalog">;
  projects: Pick<ProjectFactsCache, "label" | "settleClassifications">;
  completions: Pick<HostCompletions, "models">;
  /** The key a workspace's Pi model catalog is cached under; it changes with Pi's resources. */
  modelsKey(cwd: string): string;
  backends(): Iterable<HostRuntimeBackendProvider>;
  /** The modes Pi's runtime extensions add to its threads. */
  piModes(): readonly string[];
  defaultBackendKind: ThreadBackendKind;
  /** Whether Tau keeps a backend's program current itself (`RuntimeToolVersion.updates`). */
  toolUpdates?(kind: ThreadBackendKind): "automatic" | "ask" | undefined;
  /** Learns how a backend's program is installed before its version is published. */
  prepareToolUpdates?(kind: ThreadBackendKind): Promise<void>;
  isCurrentActivation(epoch: number): boolean;
  log(label: string, detail?: string): void;
  errorMessage(error: unknown): string;
  fail(error: unknown, sessionId?: string): void;
  /** The running threads and the host's start of each run; absent in hosts that do not keep them. */
  runs?(): Record<string, number>;
}

/**
 * What the host looks like right now: the snapshot of the thread on screen,
 * the catalogs beside it, and the updates and results clients receive of both.
 */
export class HostPublication {
  readonly detailStore = new ThreadDetailStore(5);
  private readonly modelCatalogCache = new RuntimeResourceCache<UiModel[]>({ maxEntries: 8, ttlMs: 5 * 60_000 });
  private completionModels?: UiModel[];
  private completionModelsPending = false;
  private readonly runtimeVersions: RuntimeVersions;
  /** The open workspace's label, as its kit last described it. */
  private projectLabel?: string;

  constructor(private readonly deps: HostPublicationDeps) {
    this.runtimeVersions = new RuntimeVersions({
      providers: () => deps.backends(),
      onChange: () => void this.publishActiveCatalog().catch(() => undefined),
      ...(deps.prepareToolUpdates ? { prepare: (kind: ThreadBackendKind) => deps.prepareToolUpdates!(kind) } : {}),
      log: (label, detail) => deps.log(label, detail),
    });
  }

  async snapshot(): Promise<HostSnapshot> {
    this.ensureCompletionModels();
    this.runtimeVersions.refresh();
    const models = await this.ensureModels();
    return { ...this.snapshotSync(models), projectLabel: this.deps.projects.label(this.deps.view.cwd()) };
  }

  snapshotSync(models: UiModel[]): HostSnapshot {
    const { view } = this.deps;
    return {
      ...this.deps.projection.hostSnapshot(view.active(), models, view.cwd(), view.extensionCount()),
      ...(this.completionModels ? { completionModels: this.completionModels } : {}),
      ...this.deps.workspaces.ref(view.cwd()),
      runtimeBackends: this.runtimeBackends(),
      defaultBackendKind: this.deps.defaultBackendKind,
    };
  }

  async bootstrap(): Promise<HostBootstrap> {
    // The project list is withheld while a checkout is unclassified. Bootstrap
    // is the one publication the client cannot miss, so settle it here.
    await this.deps.projects.settleClassifications();
    const host = { ...this.snapshotSync(await this.ensureModels()), projectLabel: this.projectLabel };
    const detail = this.detailForSnapshot(host);
    const result: HostBootstrap = {
      // A client that connects mid-run learns the run and its start only here.
      threadIndex: { ...this.deps.index.snapshot(), ...(this.deps.runs ? { runs: this.deps.runs() } : {}) },
      version: HOST_PROTOCOL_VERSION,
      detail,
      catalog: catalogFromSnapshot(host),
      project: this.projectMetadata(host.cwd, host.projectLabel),
    };
    this.deps.metrics.recordIpc(result);
    return result;
  }

  /** Focused active detail endpoint; it never includes catalogs or project metadata. */
  async threadDetail(cursor?: HostTranscriptCursor): Promise<TranscriptPage | ThreadDetail> {
    const snapshot = await this.snapshot();
    const result = cursor !== undefined
      ? clientTranscript(localTranscriptPage(
        snapshot.sessionId,
        snapshot.messages,
        snapshot.taskHistory,
        snapshot.turnActivityHistory,
        snapshot.turnActivityHistoryComplete,
        cursor,
      ))
      : this.detailForSnapshot(snapshot);
    this.deps.metrics.recordIpc(result);
    return result;
  }

  detailForSnapshot(snapshot: HostSnapshot, requestId?: NewThreadRequestId): ThreadDetail {
    const detail = clientTranscript(detailFromSnapshot(snapshot, undefined, localTranscriptCursorPolicy));
    this.detailStore.set(detail);
    return requestId ? { ...detail, requestId } : detail;
  }

  /** Identity and display of one workspace, as every published shape carries it. */
  projectMetadata(cwd: string, label?: string): ProjectMetadata {
    return { cwd, ...this.deps.workspaces.ref(cwd), ...(label === undefined ? {} : { label }) };
  }

  actionResult(updates: HostUpdate[]): HostActionResult {
    const result = { version: HOST_PROTOCOL_VERSION, updates } satisfies HostActionResult;
    this.deps.metrics.recordIpc(result);
    return result;
  }

  newThreadResult(
    updates: HostUpdate[],
    submission: SubmissionResult,
    requestId?: NewThreadRequestId,
    sessionId?: string,
  ): NewThreadResult {
    return {
      ...this.actionResult(updates),
      submission,
      ...(requestId ? { requestId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
  }

  lifecycleUpdates(snapshot: HostSnapshot, requestId?: NewThreadRequestId): HostUpdate[] {
    const shell = this.deps.index.byId(snapshot.sessionId);
    return [
      ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot, requestId) },
      { version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) },
      { version: HOST_PROTOCOL_VERSION, type: "project", project: this.projectMetadata(snapshot.cwd, snapshot.projectLabel), sessionId: snapshot.sessionId },
    ];
  }

  /** The lifecycle updates of the thread on screen; empty when a newer activation took the screen meanwhile. */
  async activeUpdates(activationEpoch?: number): Promise<HostActionResult> {
    const snapshot = await this.snapshot();
    if (activationEpoch !== undefined && !this.deps.isCurrentActivation(activationEpoch)) return this.actionResult([]);
    return this.actionResult(this.lifecycleUpdates(snapshot));
  }

  /** Publishes everything a client redraws after the host changed under it. */
  async publishLifecycle(): Promise<void> {
    const snapshot = await this.snapshot();
    for (const update of this.lifecycleUpdates(snapshot)) this.emitUpdate(update);
  }

  /** Publishes the transcript on screen and returns that update. */
  async publishDetail(): Promise<HostUpdate> {
    const update: HostUpdate = { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(await this.snapshot()) };
    this.emitUpdate(update);
    return update;
  }

  /** The same, without waiting for a model catalog. */
  publishDetailNow(): void {
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(this.snapshotSync([])) });
  }

  publishInitialSessionUpdates(snapshot: HostSnapshot, requestId?: NewThreadRequestId): void {
    const shell = this.deps.index.byId(snapshot.sessionId);
    const initialUpdates: HostUpdate[] = [
      ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot, requestId) },
      { version: HOST_PROTOCOL_VERSION, type: "project", project: this.projectMetadata(snapshot.cwd, snapshot.projectLabel), sessionId: snapshot.sessionId },
    ];
    for (const update of initialUpdates) {
      this.emitUpdate(update);
    }
  }

  /**
   * Publish the initial snapshot after a new-thread request has been accepted.
   * Model/catalog discovery can share a serialized backend lane with the first
   * prompt, so it must never be part of the renderer's acceptance round trip.
   */
  async publishNewSessionUpdates(activationEpoch: number, requestId: NewThreadRequestId | undefined, sessionId: string): Promise<void> {
    // Publish the thread identity and a first detail without waiting for the
    // model catalog. Catalog discovery can share the runtime's serialized
    // lane with prompt delivery; neither the renderer's promotion nor the
    // initial thread shell should depend on that slower read.
    try {
      if (!this.deps.isCurrentActivation(activationEpoch)) return;
      const snapshot = this.snapshotSync([]);
      if (!this.deps.isCurrentActivation(activationEpoch)) return;
      this.publishInitialSessionUpdates(snapshot, requestId);
    } catch (error) {
      // A runtime may expose its first detail only after its own startup
      // bookkeeping. Keep the asynchronous catalog path alive; it can still
      // publish the authoritative snapshot once that bookkeeping completes.
      this.deps.log("new-session.initial-publish.failed", this.deps.errorMessage(error));
    }
    try {
      const active = await this.activeUpdates(activationEpoch);
      if (!this.deps.isCurrentActivation(activationEpoch)) return;
      for (const update of active.updates) {
        if (requestId && update.type === "thread-detail") {
          this.emitUpdate({ ...update, detail: { ...update.detail, requestId } });
        } else {
          this.emitUpdate(update);
        }
      }
    } catch (error) {
      this.deps.fail(error, sessionId);
    }
  }

  /** A kit labelled a project; the open one's label travels with its project update. */
  publishLabel(cwd: string, label: string | undefined): void {
    if (cwd === this.deps.view.cwd()) {
      this.projectLabel = label;
      const active = this.deps.view.active();
      this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "project", project: { cwd, label }, ...(active ? { sessionId: active.threadId } : {}) });
    }
    this.deps.index.publishLabel(cwd, label);
  }

  /**
   * The backends a new thread can run on, in the one order every picker uses:
   * Pi, then registered backends by their `order`, then by registration.
   */
  runtimeBackends(): UiRuntimeBackend[] {
    const withModes = (modes: readonly string[] | undefined) => modes?.length ? { modes: [...modes] } : {};
    const registered = sortByRuntimeOrder([...this.deps.backends()].filter((provider) => !provider.hidden)).map((provider) => {
      const found = this.runtimeVersions.get(provider.kind);
      const updates = found ? this.deps.toolUpdates?.(provider.kind) : undefined;
      const version = found && updates ? { ...found, updates } : found;
      return { kind: provider.kind, label: provider.label ?? provider.kind, ...(version ? { version } : {}), ...withModes(provider.adapter.capabilities.modes), ...runtimeBackendMarks(provider) };
    });
    return [{ kind: "pi", label: "Pi", ...withModes(this.deps.piModes()) }, ...registered];
  }

  /** A backend's program changed (an update): its version is asked again and published. */
  recheckVersion(kind: ThreadBackendKind): Promise<void> {
    return this.runtimeVersions.recheck(kind);
  }

  /** `catalogFromSnapshot(await this.snapshot())` without projecting the transcript. */
  async activeCatalog(): Promise<HostCatalog> {
    this.ensureCompletionModels();
    this.runtimeVersions.refresh();
    const models = await this.ensureModels();
    return {
      ...this.deps.projection.catalog(this.deps.view.active(), models, this.deps.view.extensionCount()),
      ...(this.completionModels ? { completionModels: [...this.completionModels] } : {}),
      runtimeBackends: this.runtimeBackends().map((backend) => ({ ...backend })),
      ...(this.deps.defaultBackendKind ? { defaultBackendKind: this.deps.defaultBackendKind } : {}),
    };
  }

  async publishActiveCatalog(): Promise<void> {
    this.emitUpdate({ version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: await this.activeCatalog() });
  }

  async catalogResult(): Promise<HostActionResult> {
    const catalog = { version: HOST_PROTOCOL_VERSION, type: "catalog" as const, catalog: await this.activeCatalog() };
    this.emitUpdate(catalog);
    return this.actionResult([catalog]);
  }

  async ensureModels(): Promise<UiModel[]> {
    const active = this.deps.view.active();
    if (!active) return [];
    // Only a runtime the host builds itself pays for a catalog scan; every
    // other one answers from what it already holds.
    if (!isLocalPiRuntime(active)) return active.backend.models();
    const key = this.deps.modelsKey(this.deps.view.cwd());
    const cached = this.modelCatalogCache.get(key);
    if (cached) return cached;
    const models = await active.backend.models();
    this.modelCatalogCache.set(key, models);
    return models;
  }

  /** Pi's resources were reloaded or a provider added: the next read scans the catalog again. */
  invalidateModels(): void {
    this.modelCatalogCache.invalidate();
  }

  /** A Pi provider was signed in or out: every model list the host holds is stale. */
  credentialsChanged(): void {
    this.modelCatalogCache.invalidate();
    this.completionModels = undefined;
    this.completionModelsPending = false;
    this.ensureCompletionModels();
  }

  /**
   * The catalog a kit's small jobs may name. Building it opens the user's model
   * runtime, which is too slow to hold up a snapshot, so the first snapshot
   * goes without and a catalog update carries it a moment later.
   */
  private ensureCompletionModels(): void {
    if (this.completionModels || this.completionModelsPending) return;
    this.completionModelsPending = true;
    void this.deps.completions.models()
      .then((models) => {
        this.completionModels = models;
        return this.publishActiveCatalog();
      })
      .catch(() => { this.completionModels = []; });
  }

  private emitUpdate(update: HostUpdate): void {
    this.deps.emitUpdate(update);
  }
}
