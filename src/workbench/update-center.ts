import type { UiRuntimeTool } from "../shared/contracts";

/** Optional Machines extension service used by the ordinary app-update entry. */
export const UPDATE_CENTER_SERVICE = "tau.updates";

export interface UpdateStep {
  machine: string;
  machineName?: string;
  label: string;
  kind: "tools" | "machine" | "app";
  tools?: UiRuntimeTool[];
  version?: string;
  fromVersion?: string;
  state: "reading" | "pending" | "queued" | "running" | "done" | "failed" | "skipped";
  /** Offline during review; Update all may authorize a fresh plan when it reconnects. */
  deferUntilOnline?: boolean;
  message?: string;
  /** A request may have succeeded. Only read its result before allowing another request. */
  uncertain?: boolean;
}

export interface UpdateCenterView {
  steps: UpdateStep[];
  busy: boolean;
  reading: boolean;
  started: boolean;
  problem?: string;
}

export interface UpdateCoordinator {
  subscribe(listener: () => void): () => void;
  getSnapshot(): UpdateCenterView;
  review(): Promise<void>;
  run(resumeInterrupted: boolean): Promise<void>;
  /** Reads uncertain results; never repeats an unacknowledged install. */
  check(): Promise<void>;
  retry?(machine: string): Promise<void>;
  cancelQueued?(machine: string): Promise<void>;
}
