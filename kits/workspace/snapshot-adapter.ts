import type { DiffLoadOptions, UiFileDiff, UiWorkspaceChanges } from "tau/host-extension";
import type {
  CheckpointRefSweepOptions,
  WorkspaceSnapshot,
  WorkspaceSnapshotOptions,
} from "./workspace-snapshot-types.js";

/** Internal storage seam. Namespace, rollback and retention policy belong to workspace-snapshots. */
export interface SnapshotPair {
  beforeTreeId: string;
  afterTreeId: string;
  assertRestorable(label: string): Promise<void>;
  applyAfter(onCleaned?: () => void | Promise<void>): Promise<void>;
  diff(branch?: string): Promise<UiWorkspaceChanges>;
  fileDiff(path: string, options: DiffLoadOptions): Promise<UiFileDiff>;
  /** Returns whether this operation published a new target. */
  clone(phase: "before" | "after", targetId: string): Promise<boolean>;
}

export type SnapshotObjects = Map<string, { id?: string; type?: string }>;

export interface SnapshotAdapter {
  readonly kind: "git" | "filesystem";
  /** Undefined only when capture is unsupported, before any publication. */
  capture(options: WorkspaceSnapshotOptions, ref: string): Promise<WorkspaceSnapshot | undefined>;
  /** A filesystem pair may be absent. Git errors propagate once selected. */
  pair(before: string, after: string, validate: boolean): Promise<SnapshotPair | undefined>;
  remove(id: string, expectedTreeId?: string): Promise<void>;
  objects(prefix: string): Promise<SnapshotObjects>;
  recent(ids: readonly string[], options: CheckpointRefSweepOptions): Promise<Set<string>>;
  removeSession(sessionId: string): Promise<void>;
  gc(): Promise<void>;
}
