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
