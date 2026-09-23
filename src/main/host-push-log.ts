import {
  HOST_PUSH_BUFFER_BYTES,
  HOST_TRANSPORT_VERSION,
  type HostHello,
  type HostHelloReply,
  type HostPush,
  type HostPushEvent,
} from "../shared/host-transport.js";

/**
 * Numbers every push and keeps the latest ones up to a byte budget, so a
 * client that missed some while disconnected can replay them instead of
 * throwing its state away. The newest push is kept even when it alone is over.
 */
export class HostPushLog {
  private buffer: Array<HostPush | undefined> = [];
  private sizes: number[] = [];
  /** Entries before this index are evicted (and cleared); the arrays are compacted in bulk. */
  private head = 0;
  private bytes = 0;
  private seq = 0;

  constructor(private readonly capacityBytes: number = HOST_PUSH_BUFFER_BYTES) {}

  /** Sequence the next recorded push will carry. */
  get nextSeq(): number {
    return this.seq + 1;
  }

  record(event: HostPushEvent): HostPush {
    this.seq += 1;
    const push: HostPush = { seq: this.seq, event };
    const size = Buffer.byteLength(JSON.stringify(push));
    this.buffer.push(push);
    this.sizes.push(size);
    this.bytes += size;
    while (this.bytes > this.capacityBytes && this.head < this.buffer.length - 1) {
      this.bytes -= this.sizes[this.head]!;
      this.buffer[this.head] = undefined;
      this.head += 1;
    }
    if (this.head * 2 > this.buffer.length) {
      this.buffer = this.buffer.slice(this.head);
      this.sizes = this.sizes.slice(this.head);
      this.head = 0;
    }
    return push;
  }

  /**
   * What a client at `lastSeq` still needs. `resync` means the gap is no
   * longer in the buffer (or the host restarted): the client refetches instead.
   */
  since(lastSeq: number | undefined): { resync: boolean; missed: HostPush[] } {
    if (lastSeq === undefined) return { resync: false, missed: [] };
    if (lastSeq === this.seq) return { resync: false, missed: [] };
    if (lastSeq > this.seq) return { resync: true, missed: [] };
    const oldest = this.buffer[this.head]?.seq;
    if (oldest === undefined || lastSeq < oldest - 1) return { resync: true, missed: [] };
    // Sequences are contiguous, so the first missed push sits at a known index.
    return { resync: false, missed: this.buffer.slice(this.head + lastSeq - oldest + 1) as HostPush[] };
  }
}

/** The hello answer for one client, given what it already saw. */
export function helloReply(
  pushLog: HostPushLog,
  hello: HostHello,
  options: { hostVersion: string; capabilities: string[] },
): HostHelloReply {
  const { resync, missed } = pushLog.since(hello.lastSeq);
  return {
    protocol: HOST_TRANSPORT_VERSION,
    hostVersion: options.hostVersion,
    capabilities: options.capabilities,
    resync,
    missed,
    nextSeq: pushLog.nextSeq,
  };
}
