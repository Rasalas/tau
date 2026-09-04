import {
  HOST_PUSH_BUFFER_SIZE,
  HOST_TRANSPORT_VERSION,
  type HostHello,
  type HostHelloReply,
  type HostPush,
  type HostPushEvent,
} from "../shared/host-transport.js";

/**
 * Numbers every push and keeps the last N, so a client that missed some while
 * disconnected can replay them instead of throwing its state away.
 */
export class HostPushLog {
  private readonly buffer: HostPush[] = [];
  private seq = 0;

  constructor(private readonly capacity: number = HOST_PUSH_BUFFER_SIZE) {}

  /** Sequence the next recorded push will carry. */
  get nextSeq(): number {
    return this.seq + 1;
  }

  record(event: HostPushEvent): HostPush {
    this.seq += 1;
    const push: HostPush = { seq: this.seq, event };
    this.buffer.push(push);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
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
    const oldest = this.buffer[0]?.seq;
    if (oldest === undefined || lastSeq < oldest - 1) return { resync: true, missed: [] };
    return { resync: false, missed: this.buffer.filter((push) => push.seq > lastSeq) };
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
