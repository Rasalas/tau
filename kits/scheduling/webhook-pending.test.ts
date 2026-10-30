import { expect, it } from "vitest";
import { decodeConfig } from "./validation.js";
import { assertStateBudget } from "./store.js";
import { combineWebhook, decodePendingWebhooks, publicJob, type StoredJob } from "./webhook-pending.js";
import { decodeWebhookCoalescing } from "./webhook-coalescing.js";

const now = Date.parse("2026-10-29T12:00:00Z");
function job(): StoredJob {
  return { id: "00000000-0000-0000-0000-000000000001", workspaceId: "host:/project", enabled: true, status: "ready", config: decodeConfig({ name: "Check", workspace: "/project", backend: "pi", prompt: "Inspect", schedule: { kind: "webhook", coalescing: { keyPath: "issue.id", waitSeconds: 120 } } }) };
}
const body = (id = 1, note = "private") => Buffer.from(JSON.stringify({ issue: { id }, note }));

it.each([
  {}, [], false, "key", { keyPath: "issue[].id", waitSeconds: 120 }, { keyPath: "issue.id", waitSeconds: "120" },
  ...[0, 9, 3601, 1.5, NaN, Infinity].map((waitSeconds) => ({ keyPath: "issue.id", waitSeconds })),
  { keyPath: "issue.id", waitSeconds: 120, extra: true },
])("rejects invalid bursts configuration %j", (input) => {
  expect(() => decodeWebhookCoalescing(input)).toThrow();
});

it("shares key-path decoding, explicitly disables with null, and rejects options on non-webhook schedules", () => {
  expect(decodeWebhookCoalescing(null)).toBeNull();
  for (const waitSeconds of [10, 120, 3600]) expect(decodeWebhookCoalescing({ keyPath: "issue.labels.0.name", waitSeconds })).toEqual({ keyPath: "issue.labels.0.name", waitSeconds });
  expect(() => decodeConfig({ ...job().config, schedule: { kind: "daily", time: "09:00", timezone: "UTC", coalescing: null } })).toThrow();
});

it("validates persisted counts, time bounds, identities, bodies and key digests before scheduling", () => {
  const value = job(); combineWebhook(value, body(), now);
  const pending = value.webhookPending!;
  expect(decodePendingWebhooks(pending)).toEqual(pending);
  for (const patch of [
    { count: 0 }, { count: 10_001 }, { count: 1.5 }, { id: "invalid" }, { dueAt: new Date(now + 121_000).toISOString() },
    { keyDigest: "0".repeat(64) }, { keyDigest: undefined }, { body: "bad!" }, { body: body(2).toString("base64") },
    { coalescing: { keyPath: "issue[].id", waitSeconds: 120 } }, { extra: "field" },
  ]) expect(() => decodePendingWebhooks([{ ...pending[0], ...patch }])).toThrow();
  expect(() => decodePendingWebhooks([pending[0], pending[0]])).toThrow();
  expect(() => decodePendingWebhooks(Array(17).fill(pending[0]))).toThrow();
  expect(JSON.stringify(publicJob(value))).not.toContain("body");
  expect(JSON.stringify(publicJob(value))).not.toContain("keyDigest");
});

it("does not overwrite an expired window, caps combined counts, and reserves space for intent records", () => {
  const value = job(); combineWebhook(value, body(), now);
  combineWebhook(value, body(1, "latest"), now + 1);
  expect(value.webhookPending).toHaveLength(1);
  expect(value.webhookPending![0]!.count).toBe(2);
  combineWebhook(value, body(), now + 120_000);
  expect(value.webhookPending).toHaveLength(2);
  value.webhookPending![1]!.count = 10_000;
  expect(() => combineWebhook(value, body(), now + 120_001)).toThrow("delivery limit");
  expect(value.webhookPending![1]!.count).toBe(10_000);
  const large = job();
  for (let index = 0; index < 16; index++) combineWebhook(large, body(index, "x".repeat(60_000)), now);
  assertStateBudget({ enabled: true, jobs: [large] });
  expect(() => assertStateBudget({ enabled: true, jobs: [large, { ...large, id: "00000000-0000-0000-0000-000000000002" }] })).toThrow("budget");
});

it("treats overflowing JSON numbers as individual deliveries instead of colliding with a null key", () => {
  const value = job();
  combineWebhook(value, Buffer.from('{"issue":{"id":null}}'), now);
  combineWebhook(value, Buffer.from('{"issue":{"id":1e999}}'), now);
  combineWebhook(value, Buffer.from('{"issue":{"id":1e999}}'), now);
  expect(value.webhookPending).toHaveLength(3);
  expect(value.webhookPending![0]!.keyDigest).toBeDefined();
  for (const pending of value.webhookPending!.slice(1)) {
    expect(pending.keyDigest).toBeUndefined(); expect(pending.dueAt).toBe(pending.at);
  }
});

it("validates and redacts the latest sender facts persisted for an opted-in payload", () => {
  const value = job();
  const first = { id: "one", timestamp: now, body: body(), format: "github" as const, event: "issues", replayKey: "private-replay-key", signature: "private-signature" };
  combineWebhook(value, first.body, now, first);
  const last = { ...first, id: "two", timestamp: now + 1, body: body(1, "latest") };
  combineWebhook(value, last.body, now + 1, last);
  expect(value.webhookPending![0]!.delivery).toEqual({ id: "two", timestamp: now + 1, format: "github", event: "issues" });
  expect(decodePendingWebhooks(value.webhookPending)).toEqual(value.webhookPending);
  expect(JSON.stringify(value)).not.toContain("private-signature");
  expect(JSON.stringify(value)).not.toContain("private-replay-key");
  expect(JSON.stringify(publicJob(value))).not.toContain('"delivery"');
  for (const delivery of [
    { ...last, body: undefined }, { id: "../invalid", timestamp: now }, { id: "one", timestamp: 0 },
    { id: "one", timestamp: now, format: "unknown" }, { id: "one", timestamp: now, event: "bad\nevent" },
  ]) expect(() => decodePendingWebhooks([{ ...value.webhookPending![0], delivery }])).toThrow();
});
