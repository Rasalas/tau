import { describe, expect, it } from "vitest";
import { LINK_LIFETIMES, describeDevice, describeLastChange, formatAgo, formatExpiresIn, qrEndpoint } from "./connections-format";

const now = Date.parse("2026-09-23T12:00:00Z");

describe("connections formatting", () => {
  it("says how long ago and how long to go", () => {
    expect(formatAgo("2026-09-23T11:59:30Z", now)).toBe("just now");
    expect(formatAgo("2026-09-23T11:55:00Z", now)).toBe("5 min ago");
    expect(formatAgo("2026-09-23T09:00:00Z", now)).toBe("3 h ago");
    expect(formatAgo("2026-09-23T11:00:03Z", now)).toBe("1 h ago");
    expect(formatAgo("2026-09-21T12:00:00Z", now)).toBe("2 days ago");
    expect(formatExpiresIn("2026-09-23T12:09:10Z", now)).toBe("Expires in 9 min");
    expect(formatExpiresIn("2026-09-23T12:00:00Z", now)).toBe("Expired");
  });

  it("says what a device changed last the way a person reads it", () => {
    const at = "2026-09-23T11:55:00Z";
    expect(describeLastChange({ action: "prompt", label: "sent a prompt", thread: "Fix the queue", at }, now)).toBe("last change: sent a prompt in “Fix the queue”, 5 min ago");
    expect(describeLastChange({ action: "tau.workspace/commit", label: "committed changes", at }, now)).toBe("last change: committed changes, 5 min ago");
    // A record from before the labels.
    expect(describeLastChange({ action: "rename-thread", at }, now)).toBe("last change: rename-thread, 5 min ago");
    expect(describeLastChange({ action: "prompt", label: "sent a prompt", thread: "A very long thread title that keeps going and going", at }, now))
      .toBe("last change: sent a prompt in “A very long thread title that keeps goi…”, 5 min ago");
  });

  it("names a device by what is known of it", () => {
    expect(describeDevice({ kind: "phone", browser: "Safari", os: "iOS" })).toBe("Safari · iOS");
    expect(describeDevice({ kind: "unknown" })).toBe("");
  });

  it("never offers a loopback address as a QR code", () => {
    const loopback = { url: "http://127.0.0.1:1/", label: "This machine", reachability: "loopback" as const };
    const lan = { url: "https://192.168.1.2:1/", label: "en0", reachability: "network" as const };
    expect(qrEndpoint([loopback])).toBeUndefined();
    expect(qrEndpoint([loopback, lan])).toBe(lan);
    expect(qrEndpoint([lan], "http://127.0.0.1:1/")).toBe(lan);
  });

  it("offers the lifetimes the host accepts", () => {
    expect(LINK_LIFETIMES.map((entry) => entry.label)).toEqual(["10 min", "1 h", "1 day"]);
  });
});
