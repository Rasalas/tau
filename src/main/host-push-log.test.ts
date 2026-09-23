import { describe, expect, it } from "vitest";
import { HostPushLog, helloReply } from "./host-push-log.js";
import { HOST_TRANSPORT_VERSION } from "../shared/host-transport.js";

const event = (label: string) => ({ type: "event-log" as const, label, timestamp: 0 });
const options = { hostVersion: "1.2.3", capabilities: ["jobs"] };

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
});
