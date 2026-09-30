import { describe, expect, it } from "vitest";
import { activityRequest, readActivityRegistration } from "./mobile-activity.js";
describe("ActivityKit device registration", () => {
  it("binds a token to the authenticated device rather than caller data", () => {
    const registration = readActivityRegistration({ hostId: "host", threadId: "thread", token: "ab".repeat(32), topic: "de.tbuck.tau", device: "attacker" }, "paired-phone", 1000);
    expect(registration.device).toBe("paired-phone"); expect(registration.expiresAt).toBe(1000 + 8 * 60 * 60_000);
  });
  it("rejects arbitrary APNs topics and tokens", () => {
    expect(() => readActivityRegistration({ hostId: "host", threadId: "thread", token: "http://evil", topic: "de.tbuck.tau" }, "phone", 0)).toThrow();
  });
  it("sets the Live Activity APNs topic, type, content state and terminal dismissal", () => {
    const registration = readActivityRegistration({ hostId: "host", threadId: "thread", token: "ab".repeat(32), topic: "de.tbuck.tau" }, "phone", 1000);
    expect(activityRequest(registration, { version: 1, hostId: "host", threadId: "thread", title: "Build", state: "completed", updatedAt: 5000, expiresAt: 905000 })).toMatchObject({ pushType: "liveactivity", topic: "de.tbuck.tau.push-type.liveactivity", expiration: 905, payload: { aps: { timestamp: 5, event: "end", "dismissal-date": 905, "content-state": { title: "Build", state: "completed" } } } });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityTokens } from "./mobile-activity.js";
import { vi } from "vitest";

it("persists activity registrations, expires them and never sends after device revocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-activities-"));
  try {
    const store = await ActivityTokens.open(dir, { warn: () => undefined });
    const registration = readActivityRegistration({ hostId: "host", threadId: "thread", token: "ab".repeat(32), topic: "de.tbuck.tau" }, "phone", 1000);
    await store.register(registration);
    const reopened = await ActivityTokens.open(dir, { warn: () => undefined });
    const send = vi.fn(async () => ({ ok: true as const }));
    await reopened.update("thread", "running", "Build", 2000, new Set(["phone"]), () => "sandbox", send);
    expect(send).toHaveBeenCalledOnce();
    await reopened.retain(new Set(), 3000);
    await reopened.update("thread", "completed", "Build", 4000, new Set(["phone"]), () => "sandbox", send);
    expect(send).toHaveBeenCalledOnce();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("seals a background ActivityKit update and hands the relay an opaque handle without a token or readable title", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-activity-relay-"));
  try {
    const store = await ActivityTokens.open(dir, { warn: () => undefined });
    const registration = readActivityRegistration({ hostId: "host", threadId: "thread", topic: "de.tbuck.tau", relay: { handle: "h".repeat(64), keyId: "k".repeat(22), key: Buffer.alloc(32, 7).toString("base64url") } }, "phone", 1_700_000_000_000);
    expect(registration.token).toBeUndefined(); await store.register(registration);
    const direct = vi.fn(async () => ({ ok: true as const })); const relay = vi.fn(async () => ({ ok: true as const }));
    await store.update("thread", "needs-input", "Private project", 1_700_000_001_000, new Set(["phone"]), () => undefined, direct, relay);
    expect(direct).not.toHaveBeenCalled(); expect(relay).toHaveBeenCalledOnce();
    const wire = JSON.stringify(relay.mock.calls[0]);
    expect(wire).not.toContain("Private project"); expect(wire).not.toContain('"thread"'); expect(wire).not.toContain('"token"');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
