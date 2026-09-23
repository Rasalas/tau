import type {
  HostSnapshot,
  NewThreadRequestId,
  SubmissionResult,
} from "../shared/contracts.js";
import {
  HOST_PROTOCOL_VERSION,
  catalogFromSnapshot,
  detailFromSnapshot,
  type HostActionResult,
  type HostUpdate,
  type NewThreadResult,
  type ProjectMetadata,
  type ThreadDetail,
} from "../shared/host-protocol.js";
import { localTranscriptCursorPolicy } from "./host-transcript.js";
import { clientTranscript } from "./client-tool-output.js";
import { ThreadDetailStore } from "../shared/thread-detail-store.js";
import type { ThreadIndex } from "./thread-index.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";
import type { HostLifecycleInstrumentation } from "./host-lifecycle.js";

export interface HostPublicationDeps {
  index: ThreadIndex;
  workspaces: WorkspaceIdentity;
  metrics: HostLifecycleInstrumentation;
  emitUpdate(update: HostUpdate): void;
}

/**
 * HostPublication owns the state projection cluster:
 * translating internal runtime snapshots into external client projections
 * (ThreadDetail, ProjectMetadata, HostUpdate, HostActionResult).
 */
export class HostPublication {
  private readonly index: ThreadIndex;
  private readonly workspaces: WorkspaceIdentity;
  private readonly metrics: HostLifecycleInstrumentation;
  private readonly emit: (update: HostUpdate) => void;
  readonly detailStore = new ThreadDetailStore(5);

  constructor(deps: HostPublicationDeps) {
    this.index = deps.index;
    this.workspaces = deps.workspaces;
    this.metrics = deps.metrics;
    this.emit = deps.emitUpdate;
  }

  detailForSnapshot(snapshot: HostSnapshot, requestId?: NewThreadRequestId): ThreadDetail {
    const detail = clientTranscript(detailFromSnapshot(snapshot, undefined, localTranscriptCursorPolicy));
    this.detailStore.set(detail);
    return requestId ? { ...detail, requestId } : detail;
  }

  projectMetadata(cwd: string, label?: string): ProjectMetadata {
    return { cwd, ...this.workspaces.ref(cwd), ...(label === undefined ? {} : { label }) };
  }

  actionResult(updates: HostUpdate[]): HostActionResult {
    const result = { version: HOST_PROTOCOL_VERSION, updates } satisfies HostActionResult;
    this.metrics.recordIpc(result);
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
    const shell = this.index.byId(snapshot.sessionId);
    return [
      ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot, requestId) },
      { version: HOST_PROTOCOL_VERSION, type: "catalog", catalog: catalogFromSnapshot(snapshot) },
      { version: HOST_PROTOCOL_VERSION, type: "project", project: this.projectMetadata(snapshot.cwd, snapshot.projectLabel) },
    ];
  }

  publishInitialSessionUpdates(snapshot: HostSnapshot, requestId?: NewThreadRequestId): void {
    const shell = this.index.byId(snapshot.sessionId);
    const initialUpdates: HostUpdate[] = [
      ...(shell ? [{ version: HOST_PROTOCOL_VERSION, type: "thread-shell" as const, update: { sessionId: shell.id, shell } }] : []),
      { version: HOST_PROTOCOL_VERSION, type: "thread-detail", detail: this.detailForSnapshot(snapshot, requestId) },
      { version: HOST_PROTOCOL_VERSION, type: "project", project: this.projectMetadata(snapshot.cwd, snapshot.projectLabel) },
    ];
    for (const update of initialUpdates) {
      this.emit(update);
    }
  }
}
