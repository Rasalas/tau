import { createDecipheriv } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ActivityStarts, readActivityStart, sealActivity } from "./activity-start";
import type { RelaySend } from "./relay";
import type { ActivityUpdate } from "./mobile-activity";
const NOW = 1_700_000_000_000;
const key = { handle: "h".repeat(64), keyId: "k".repeat(22), key: Buffer.alloc(32, 7).toString("base64url") };
const input = { hostId: "host", topic: "de.tbuck.tau", enabled: true, relay: key };
const update: ActivityUpdate = { version: 1, hostId: "host", threadId: "private-thread", title: "Private task", state: "running", updatedAt: NOW, expiresAt: NOW + 8 * 60 * 60_000 };
function open(sealed: string, purpose: string, id: string, tokenHash = "") {
  const [version, keyId, text] = sealed.split("."); expect(version).toBe("2");
  const bytes = Buffer.from(text!, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key.key, "base64url"), bytes.subarray(0, 12));
  decipher.setAAD(Buffer.from(`tau-activity:2:${keyId}:${purpose}:${id}:${tokenHash}`)); decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString("utf8"));
}
describe("encrypted remote activity starts", () => {
  it("requires affirmative opt-in and encrypted key material", () => {
    expect(() => readActivityStart({ ...input, enabled: false }, "phone", NOW)).toThrow(/opt-in/u);
    expect(() => readActivityStart({ ...input, relay: undefined, token: "ab".repeat(32) }, "phone", NOW)).toThrow(/encrypted/u);
    expect(readActivityStart({ ...input, device: "forged" }, "phone", NOW)).toMatchObject({ device: "phone", expiresAt: NOW + 30 * 24 * 60 * 60_000 });
  });
  it("authenticates purpose, activity id, key id and the per-activity APNs token digest", () => {
    const id = "a".repeat(22), tokenHash = "b".repeat(64);
    const start = sealActivity(key, update, "start", id);
    expect(open(start, "start", id)).toEqual(update);
    expect(() => open(start, "update", id, tokenHash)).toThrow();
    expect(() => open(start, "start", "c".repeat(22))).toThrow();
    const sealed = sealActivity(key, update, "update", id, tokenHash);
    expect(open(sealed, "update", id, tokenHash)).toEqual(update);
    expect(() => open(sealed, "update", id, "d".repeat(64))).toThrow();
    expect(() => open(sealed.replace(key.keyId, "f".repeat(22)), "update", id, tokenHash)).toThrow();
  });
  it("persists consent and deduplication, caps starts, and drops revoked/expired phones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-starts-"));
    try {
      const store = await ActivityStarts.open(dir, { warn: () => undefined });
      const send = vi.fn(async (_request: RelaySend) => ({ ok: true as const }));
      await store.start("private-thread", "Private task", NOW, new Set(["phone"]), () => false, send);
      expect(send).not.toHaveBeenCalled();
      await store.register(readActivityStart(input, "phone", NOW));
      await store.start("private-thread", "Private task", NOW, new Set(["phone"]), () => false, send);
      const request = send.mock.calls[0]![0];
      expect(JSON.stringify(request)).not.toMatch(/Private task|private-thread|"host"|"token"/u);
      expect(request.activity).toMatchObject({ event: "start" });
      expect(open(request.payload, "start", request.activity!.activityId!)).toEqual(update);
      const reopened = await ActivityStarts.open(dir, { warn: () => undefined });
      await reopened.start("private-thread", "Private task", NOW + 1000, new Set(["phone"]), () => false, send);
      expect(send).toHaveBeenCalledOnce();
      await reopened.start("second", "Task", NOW + 1000, new Set(["phone"]), () => false, send);
      await reopened.start("third", "Task", NOW + 2000, new Set(["phone"]), () => false, send);
      await reopened.start("fourth", "Task", NOW + 3000, new Set(["phone"]), () => false, send);
      expect(send).toHaveBeenCalledTimes(3);
      await reopened.retain(new Set(), NOW + 4000);
      await reopened.start("revoked", "Task", NOW + 5000, new Set(["phone"]), () => false, send);
      expect(send).toHaveBeenCalledTimes(3);
      await reopened.register(readActivityStart(input, "phone", NOW));
      await reopened.start("expired", "Task", NOW + 31 * 24 * 60 * 60_000, new Set(["phone"]), () => false, send);
      expect(send).toHaveBeenCalledTimes(3);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("requires the started activity's authenticated device and key for subsequent registration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-start-owner-"));
    try {
      const store = await ActivityStarts.open(dir, { warn: () => undefined }); const send = vi.fn(async (_request: RelaySend) => ({ ok: true as const }));
      await store.register(readActivityStart(input, "phone", NOW));
      await store.start("thread", "Task", NOW, new Set(["phone"]), () => false, send);
      const row = { device: "phone", hostId: "host", threadId: "thread", activityId: send.mock.calls[0]![0].activity!.activityId, relay: key, topic: "de.tbuck.tau", expiresAt: NOW + 1000 };
      expect(store.owns(row)).toBe(true);
      expect(store.owns({ ...row, device: "other" })).toBe(false);
      expect(store.owns({ ...row, relay: { ...key, keyId: "other" } })).toBe(false);
      await store.remove("phone"); expect(store.owns(row)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it("allows a later turn in a completed thread and retains the old activity's final state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-start-later-"));
  try {
    const store = await ActivityStarts.open(dir, { warn: () => undefined });
    const send = vi.fn(async (_request: RelaySend) => ({ ok: true as const }));
    await store.register(readActivityStart(input, "phone", NOW));
    await store.start("thread", "Task", NOW, new Set(["phone"]), () => false, send);
    const old = { device: "phone", hostId: "host", threadId: "thread", activityId: send.mock.calls[0]![0].activity!.activityId, relay: key, topic: "de.tbuck.tau", expiresAt: NOW + 1000 };
    await store.note("thread", "completed");
    const reopened = await ActivityStarts.open(dir, { warn: () => undefined });
    await reopened.start("thread", "Task", NOW + 1000, new Set(["phone"]), () => false, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(reopened.state(old)).toBe("completed");
    expect(reopened.state({ ...old, activityId: send.mock.calls[1]![0].activity!.activityId })).toBe("running");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
