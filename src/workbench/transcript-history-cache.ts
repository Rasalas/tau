import type { HostSnapshot, ThreadIndexSnapshot } from "../shared/contracts";
import type { ThreadDetail } from "../shared/host-protocol";
import { ThreadDetailStore } from "../shared/thread-detail-store";
import { scheduleBootstrapCache, writeBootstrapCache } from "./bootstrap-cache";
import { getClientStorage } from "./client-storage";

/**
 * Persistence and bounded detail ownership, kept out of request coordination.
 * The detail store is passed in: the renderer keeps exactly one, shared with
 * the thread view store, so no thread is cached twice in memory.
 */
export class TranscriptHistoryCache {
  readonly details: ThreadDetailStore;
  private snapshot?: HostSnapshot;
  private index?: ThreadIndexSnapshot;

  constructor(snapshot?: HostSnapshot, index?: ThreadIndexSnapshot, details = new ThreadDetailStore(5)) {
    this.details = details;
    this.snapshot = snapshot;
    this.index = index;
  }

  getDetail(sessionId: string): ThreadDetail | undefined {
    return this.details.get(sessionId);
  }

  setDetail(detail: ThreadDetail): void {
    this.details.set(detail);
  }

  getSnapshot(): HostSnapshot | undefined {
    return this.snapshot;
  }

  setSnapshot(snapshot: HostSnapshot | undefined): void {
    this.snapshot = snapshot;
  }

  /** An index arrives with every thread's change; its write joins the coalesced one. */
  setThreadIndex(index: ThreadIndexSnapshot, snapshot = this.snapshot): void {
    this.index = index;
    scheduleBootstrapCache(snapshot, this.index, getClientStorage());
  }

  persist(snapshot = this.snapshot): void {
    writeBootstrapCache(snapshot, this.index);
  }
}
