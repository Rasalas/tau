import { describe, expect, it } from "vitest";
import { HostPushLog, helloReply } from "./host-push-log.js";
import { HOST_TRANSPORT_VERSION } from "../shared/host-transport.js";
import { HostPushFilter } from "./host-push-scope.js";

const event = (label: string) => ({ type: "event-log" as const, label, timestamp: 0 });
const options = { hostVersion: "1.2.3", capabilities: ["jobs"] };
const delta = (sessionId: string, text: string) => ({ type: "assistant-delta" as const, sessionId, id: "a", delta: text });

describe("host push log", () => {
  it("numbers pushes from one", () => {
    const log = new HostPushLog();
    expect(log.nextSeq).toBe(1);
    expect(log.record(event("a"))).toEqual({ seq: 1, event: event("a") });
    expect(log.record(event("b")).seq).toBe(2);
    expect(log.nextSeq).toBe(3);
  });

  it("replays only what a client has not seen", () => {
    const log = new HostPushLog();
    for (const label of ["a", "b", "c"]) log.record(event(label));
    expect(log.since(3)).toEqual({ resync: false, missed: [] });
    expect(log.since(1).missed.map((push) => push.seq)).toEqual([2, 3]);
    expect(log.since(undefined)).toEqual({ resync: false, missed: [] });
  });

  it("asks for a resync when the gap fell out of the buffer", () => {
    const size = Buffer.byteLength(JSON.stringify({ seq: 1, event: event("a") }));
    const log = new HostPushLog(size * 2);
    for (const label of ["a", "b", "c", "d"]) log.record(event(label));
    // Only 3 and 4 fit the byte budget; a client at 1 cannot be repaired.
    expect(log.since(2).missed.map((push) => push.seq)).toEqual([3, 4]);
    expect(log.since(1).resync).toBe(true);
  });

  it("bounds the buffer by bytes, keeping the newest push even when it alone is over", () => {
    const log = new HostPushLog(1_000);
    for (let index = 0; index < 50; index += 1) log.record(event(`small-${index}`));
    expect(log.since(0).resync).toBe(true);
    expect(log.since(40).missed.map((push) => push.seq)).toEqual([41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
    log.record(event("x".repeat(5_000)));
    expect(log.since(50).missed.map((push) => push.seq)).toEqual([51]);
    expect(log.since(49).resync).toBe(true);
  });

  it("asks for a resync when the client is ahead of the host", () => {
    const log = new HostPushLog();
    log.record(event("a"));
    expect(log.since(9).resync).toBe(true);
  });

  it("answers hello with the version, capabilities and the missed pushes", () => {
    const log = new HostPushLog();
    log.record(event("a"));
    log.record(event("b"));
    const reply = helloReply(log, { protocol: HOST_TRANSPORT_VERSION, lastSeq: 1 }, options);
    expect(reply).toMatchObject({ protocol: 1, hostVersion: "1.2.3", capabilities: ["jobs"], resync: false, nextSeq: 3 });
    expect(reply.missed.map((push) => push.seq)).toEqual([2]);
  });

  it("replays to a subscribed client only what it would have been sent", () => {
    const log = new HostPushLog();
    log.record(delta("shown", "a"));
    log.record(delta("other", "b"));
    log.record(event("everyone"));
    log.record(delta("other", "c"));
    const filter = new HostPushFilter({ threads: ["shown"], topics: [] });
    expect(log.since(0, filter).missed.map((push) => push.seq)).toEqual([1, 3]);
    const reply = helloReply(log, { protocol: HOST_TRANSPORT_VERSION, lastSeq: 1 }, options, filter);
    expect(reply.missed.map((push) => push.seq)).toEqual([3]);
    expect(reply.nextSeq).toBe(5);
  });

  it("needs no resync when only other threads' pushes fell out", () => {
    const size = Buffer.byteLength(JSON.stringify({ seq: 1, event: delta("other", "x".repeat(100)) }));
    const log = new HostPushLog(size * 3);
    log.record(delta("shown", "a"));
    for (let index = 0; index < 10; index += 1) log.record(delta("other", "x".repeat(100)));
    const shown = new HostPushFilter({ threads: ["shown"], topics: [] });
    // The client saw push 1; everything after it was for another thread.
    expect(log.since(1, shown)).toEqual({ resync: false, missed: [] });
    expect(log.since(1).resync).toBe(true);
    // A client that follows the other thread did lose some.
    expect(log.since(1, new HostPushFilter({ threads: ["other"], topics: [] })).resync).toBe(true);
    // And so did one that saw nothing since before push 1 fell out.
    log.record(event("everyone"));
    for (let index = 0; index < 3; index += 1) log.record(delta("other", "x".repeat(100)));
    expect(log.since(1, shown).resync).toBe(true);
  });
});
