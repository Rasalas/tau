import { describe, expect, it } from "vitest";
import {
  HOST_TRANSPORT_VERSION,
  decodeHostClientFrame,
  decodeHostHello,
  decodeHostHelloReply,
  decodeHostPush,
  decodeHostRequest,
  decodeHostResponse,
  decodeHostServerFrame,
  isHostJobEvent,
  jobMethodKey,
} from "./host-transport.js";

const push = { seq: 3, event: { type: "agent-status", sessionId: "s", running: true } };

describe("host transport frames", () => {
  it("accepts a request and defaults its params", () => {
    expect(decodeHostRequest({ id: "r1", method: "bootstrap" })).toEqual({ id: "r1", method: "bootstrap", params: [] });
    expect(decodeHostRequest({ id: "r1", method: "abort", params: ["s"] })?.params).toEqual(["s"]);
  });

  it("rejects a request without an id, a method, or with non-array params", () => {
    expect(decodeHostRequest({ method: "bootstrap" })).toBeUndefined();
    expect(decodeHostRequest({ id: "r1" })).toBeUndefined();
    expect(decodeHostRequest({ id: "r1", method: "x", params: { text: "hi" } })).toBeUndefined();
    expect(decodeHostRequest("bootstrap")).toBeUndefined();
  });

  it("keeps result and error apart in a response", () => {
    expect(decodeHostResponse({ id: "r1", result: 7 })).toEqual({ id: "r1", result: 7 });
    expect(decodeHostResponse({ id: "r1", error: { message: "no", code: "failed" } })?.error?.code).toBe("failed");
    expect(decodeHostResponse({ id: "r1", error: { message: "no" } })).toBeUndefined();
  });

  it("takes a hello only at the version it knows", () => {
    expect(decodeHostHello({ protocol: HOST_TRANSPORT_VERSION, lastSeq: 12 })).toEqual({ protocol: 1, lastSeq: 12 });
    expect(decodeHostHello({ protocol: 2 })).toBeUndefined();
    expect(decodeHostHello({ protocol: 1, lastSeq: 1.5 })).toBeUndefined();
    expect(decodeHostHello({ protocol: 1, token: 7 })).toBeUndefined();
  });

  it("requires a positive sequence and a typed event on a push", () => {
    expect(decodeHostPush(push)).toEqual(push);
    expect(decodeHostPush({ seq: 0, event: { type: "x" } })).toBeUndefined();
    expect(decodeHostPush({ seq: 1, event: {} })).toBeUndefined();
    expect(decodeHostPush({ seq: 1 })).toBeUndefined();
  });

  it("refuses a host-update push whose update is contradictory", () => {
    expect(decodeHostPush({ seq: 1, event: { type: "host-update", update: { version: 1, type: "nonsense" } } })).toBeUndefined();
    const valid = { seq: 1, event: { type: "host-update", update: { version: 1, type: "error", message: "boom" } } };
    expect(decodeHostPush(valid)).toEqual(valid);
  });

  it("checks the transport's compact events before they reach a client", () => {
    const tool = { id: "t1", name: "bash", args: {}, status: "done", startedAt: 0 };
    const end = { seq: 2, event: { type: "tool-end-delta", sessionId: "s", tool, after: 1, length: 3, keep: 3, drop: 0, text: "" } };
    expect(decodeHostPush(end)).toEqual(end);
    expect(decodeHostPush({ seq: 2, event: { ...end.event, length: -1 } })).toBeUndefined();
    expect(decodeHostPush({ seq: 2, event: { ...end.event, tool: { name: "bash" } } })).toBeUndefined();
    const detail = { seq: 3, event: { type: "thread-detail-compact", update: { version: 1, type: "thread-detail", detail: { sessionId: "s", messages: [], isStreaming: false, activeTools: [] } } } };
    expect(decodeHostPush(detail)).toEqual(detail);
    expect(decodeHostPush({ seq: 3, event: { type: "thread-detail-compact", update: { version: 1, type: "error", message: "boom" } } })).toBeUndefined();
    const texts = { seq: 3, event: { ...detail.event, activityFromHistory: true, texts: { a1: 2 } } };
    expect(decodeHostPush(texts)).toEqual(texts);
    expect(decodeHostPush({ seq: 3, event: { ...detail.event, texts: { a1: "2" } } })).toBeUndefined();
    expect(decodeHostPush({ seq: 3, event: { ...detail.event, activityFromHistory: 1 } })).toBeUndefined();
    const message = { id: "a1", role: "assistant", timestamp: 1 };
    const ended = { seq: 4, event: { type: "assistant-end-delta", sessionId: "s", message, after: 3, text: { keep: 5, drop: 0, text: "" } } };
    expect(decodeHostPush(ended)).toEqual(ended);
    expect(decodeHostPush({ seq: 4, event: { ...ended.event, thinking: { keep: 1, drop: 0, text: "" } } })).toBeDefined();
    expect(decodeHostPush({ seq: 4, event: { ...ended.event, text: { keep: -1, drop: 0, text: "" } } })).toBeUndefined();
    expect(decodeHostPush({ seq: 4, event: { ...ended.event, thinking: "plan" } })).toBeUndefined();
    expect(decodeHostPush({ seq: 4, event: { ...ended.event, message: { role: "assistant" } } })).toBeUndefined();
  });

  it("decodes a hello reply with its replayed pushes", () => {
    const reply = { protocol: 1, hostVersion: "0.0.0", capabilities: ["jobs"], resync: false, missed: [push], nextSeq: 4 };
    expect(decodeHostHelloReply(reply)?.missed).toHaveLength(1);
    expect(decodeHostHelloReply({ ...reply, missed: [{ seq: -1, event: { type: "x" } }] })).toBeUndefined();
    expect(decodeHostHelloReply({ ...reply, capabilities: [1] })).toBeUndefined();
  });

  it("routes the socket frames by type", () => {
    expect(decodeHostClientFrame({ type: "request", request: { id: "r", method: "abort" } })?.type).toBe("request");
    expect(decodeHostClientFrame({ type: "hello", id: "h", hello: { protocol: 1 } })?.type).toBe("hello");
    expect(decodeHostClientFrame({ type: "hello", hello: { protocol: 1 } })).toBeUndefined();
    expect(decodeHostClientFrame({ type: "push", push })).toBeUndefined();
    expect(decodeHostServerFrame({ type: "push", push })?.type).toBe("push");
    expect(decodeHostServerFrame({ type: "response", response: { id: "r" } })?.type).toBe("response");
    expect(decodeHostServerFrame({ type: "nonsense" })).toBeUndefined();
  });

  it("names job events and job methods", () => {
    expect(isHostJobEvent({ type: "job-done", jobId: "job-1" })).toBe(true);
    expect(isHostJobEvent({ type: "agent-status", sessionId: "s", running: false })).toBe(false);
    expect(jobMethodKey("rebuild-workbench")).toBe("rebuild-workbench");
    expect(jobMethodKey("host-extension", "tau.kit", "long")).toBe("host-extension:tau.kit/long");
  });
});
