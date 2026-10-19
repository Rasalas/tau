import { randomUUID } from "node:crypto";
import {
  HOST_PUSH_BUFFER_BYTES,
  HOST_TRANSPORT_VERSION,
  type HostHello,
  type HostHelloReply,
  type HostIdentity,
  type HostPush,
  type HostPushEvent,
} from "../shared/host-transport.js";
import { hostPushScope, type HostPushFilter, type HostPushScope } from "./host-push-scope.js";

const MAX_EVICTED_SCOPES = 1_024;
/** What the slot of a push that is never replayed counts against the budget, so such slots stay bounded. */
const RELAY_SLOT_BYTES = 16;

/**
 * Numbers every push and keeps the latest ones up to a byte budget, so a
 * client that missed some while disconnected can replay them instead of
 * throwing its state away. The newest push is kept even when it alone is over.
 * A subscribed client replays only the pushes it would have been sent, and
 * needs a resync only when one of those fell out. Each kept push holds its
 * JSON, which the socket sends and replays without serializing it again.
 */
export class HostPushLog {
  readonly bootId = randomUUID();
  /** Undefined for an evicted push and for one that is never replayed. */
  private buffer: Array<HostPush | undefined> = [];
  private texts: Array<string | undefined> = [];
  private sizes: number[] = [];
  private scopes: HostPushScope[] = [];
  /** The newest evicted push per scope (`""` for pushes to everyone). */
  private readonly evicted = new Map<string, number>();
  /** Entries before this index are evicted (and cleared); the arrays are compacted in bulk. */
  private head = 0;
  private bytes = 0;
  private seq = 0;

  constructor(private readonly capacityBytes: number = HOST_PUSH_BUFFER_BYTES) {}

  /** Sequence the next recorded push will carry. */
  get nextSeq(): number {
    return this.seq + 1;
  }

  /** Client-only relays keep sequence ordering but never replay to another connection. */
  record(event: HostPushEvent, options: { replay?: boolean } = {}): HostPush {
    this.seq += 1;
    const push: HostPush = { seq: this.seq, event };
    const replay = options.replay !== false;
    const text = replay ? JSON.stringify(event) : undefined;
    // `{"seq":N,"event":…}`, as the push travels.
    const size = text === undefined ? RELAY_SLOT_BYTES : Buffer.byteLength(text) + 17 + String(this.seq).length;
    this.buffer.push(replay ? push : undefined);
    this.texts.push(text);
    this.sizes.push(size);
    this.scopes.push(hostPushScope(event));
    this.bytes += size;
    while (this.bytes > this.capacityBytes && this.head < this.buffer.length - 1) {
      this.bytes -= this.sizes[this.head]!;
      const evicted = this.buffer[this.head];
      if (evicted) this.forget(this.scopes[this.head], evicted.seq);
      this.buffer[this.head] = undefined;
      this.texts[this.head] = undefined;
      this.head += 1;
    }
    if (this.head * 2 > this.buffer.length) {
      this.buffer = this.buffer.slice(this.head);
      this.texts = this.texts.slice(this.head);
      this.sizes = this.sizes.slice(this.head);
      this.scopes = this.scopes.slice(this.head);
      this.head = 0;
    }
    return push;
  }

  /** The push's event as JSON: the text recorded with it while it is kept. */
  eventText(push: HostPush): string {
    const index = this.head + push.seq - this.oldestSeq();
    return (index >= this.head && this.buffer[index] === push ? this.texts[index] : undefined) ?? JSON.stringify(push.event);
  }

  /** Recorded pushes as a JSON array's items, from the texts kept with them. */
  pushesText(pushes: readonly HostPush[]): string {
    return pushes.map((push) => `{"seq":${push.seq},"event":${this.eventText(push)}}`).join(",");
  }

  /** Sequences are contiguous, so the oldest kept slot follows from the newest. */
  private oldestSeq(): number {
    return this.seq - (this.buffer.length - this.head) + 1;
  }

  private forget(scope: HostPushScope, seq: number): void {
    this.evicted.set(scope ?? "", seq);
    if (this.evicted.size <= MAX_EVICTED_SCOPES) return;
    // Too many threads to track one by one: count them all as evicted to everyone.
    const newest = Math.max(...this.evicted.values());
    this.evicted.clear();
    this.evicted.set("", newest);
  }

  /**
   * What a client at `lastSeq` still needs. `resync` means the gap is no
   * longer in the buffer (or the host restarted): the client refetches instead.
   */
  since(lastSeq: number | undefined, filter?: HostPushFilter, readOnly = false): { resync: boolean; missed: HostPush[] } {
    if (lastSeq === undefined) return { resync: false, missed: [] };
    if (lastSeq === this.seq) return { resync: false, missed: [] };
    if (lastSeq > this.seq) return { resync: true, missed: [] };
    if (this.head >= this.buffer.length) return { resync: true, missed: [] };
    const oldest = this.oldestSeq();
    if (lastSeq < oldest - 1 && this.lostAny(lastSeq, filter)) return { resync: true, missed: [] };
    // Sequences are contiguous, so the first missed push sits at a known index.
    const from = this.head + Math.max(0, lastSeq - oldest + 1);
    const missed: HostPush[] = [];
    for (let index = from; index < this.buffer.length; index++) {
      const push = this.buffer[index];
      const scope = this.scopes[index];
      if (push && !(readOnly && scope === "writers") && (filter?.admits(push.event, scope) ?? true)) missed.push(push);
    }
    return { resync: false, missed };
  }

  /** Whether a push after `lastSeq` that this client would have been sent was evicted. */
  private lostAny(lastSeq: number, filter: HostPushFilter | undefined): boolean {
    for (const [scope, seq] of this.evicted) {
      if (seq > lastSeq && (!filter || filter.mayAdmit(scope === "" ? undefined : scope as HostPushScope))) return true;
    }
    return false;
  }
}

/** The hello answer for one client, given what it already saw. */
export function helloReply(
  pushLog: HostPushLog,
  hello: HostHello,
  options: { hostVersion: string; capabilities: string[]; host?: HostIdentity },
  filter?: HostPushFilter,
  readOnly = false,
): HostHelloReply {
  const { resync, missed } = hello.lastSeq !== undefined && hello.bootId !== pushLog.bootId
    ? { resync: true, missed: [] }
    : pushLog.since(hello.lastSeq, filter, readOnly);
  return {
    protocol: HOST_TRANSPORT_VERSION,
    hostVersion: options.hostVersion,
    capabilities: options.capabilities,
    bootId: pushLog.bootId,
    resync,
    missed,
    nextSeq: pushLog.nextSeq,
    ...(options.host ? { host: options.host } : {}),
  };
}
