import type { HostSnapshot, ThreadIndexSnapshot } from "../shared/contracts";
import type { ThreadDetail } from "../shared/host-protocol";
import { ThreadDetailStore } from "../shared/thread-detail-store";
import { writeBootstrapCache } from "./bootstrap-cache";

/** Persistence and bounded detail ownership, kept out of request coordination. */
export class TranscriptHistoryCache {
  readonly details = new ThreadDetailStore(5);
  private snapshot?: HostSnapshot;
  private index?: ThreadIndexSnapshot;

  constructor(snapshot?: HostSnapshot, index?: ThreadIndexSnapshot) {
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

  setThreadIndex(index: ThreadIndexSnapshot): void {
    this.index = index;
    this.persist();
  }

  persist(): void {
    writeBootstrapCache(this.snapshot, this.index);
  }
}
