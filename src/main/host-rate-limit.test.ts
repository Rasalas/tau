import { describe, expect, it } from "vitest";
import { createAuthRateLimiter } from "./host-rate-limit.js";

describe("authentication attempt limiter", () => {
  it("allows a bounded burst per source and normalizes IPv4-mapped addresses", () => {
    const admit = createAuthRateLimiter(() => 0);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(admit("192.0.2.1")).toBe(0);
    expect(admit("192.0.2.1")).toBe(1000);
    expect(admit("::ffff:192.0.2.1")).toBe(1000);
    expect(admit("192.0.2.2")).toBe(0);
  });

  it.each(["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1"])("allows a larger but finite loopback burst for %s", (source) => {
    const admit = createAuthRateLimiter(() => 0);
    for (let attempt = 0; attempt < 20; attempt += 1) expect(admit(source)).toBe(0);
    expect(admit(source)).toBe(1000);
  });

  it("doubles backoff up to one minute without extending it for rejected attempts", () => {
    let fakeNow = 0;
    const admit = createAuthRateLimiter(() => fakeNow);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(admit("192.0.2.1")).toBe(0);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      expect(admit("192.0.2.1")).toBe(delay);
      fakeNow += delay - 1;
      expect(admit("192.0.2.1")).toBe(1);
      fakeNow += 1;
      expect(admit("192.0.2.1")).toBe(0);
    }
  });

  it("resets a source after ten idle minutes", () => {
    let fakeNow = 0;
    const admit = createAuthRateLimiter(() => fakeNow);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(admit("192.0.2.1")).toBe(0);
    expect(admit("192.0.2.1")).toBe(1000);
    fakeNow = 10 * 60 * 1000;
    for (let attempt = 0; attempt < 5; attempt += 1) expect(admit("192.0.2.1")).toBe(0);
    expect(admit("192.0.2.1")).toBe(1000);
  });

  it("shares a finite bucket for unknown sources and keeps instances independent", () => {
    const admit = createAuthRateLimiter(() => 0);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(admit(undefined)).toBe(0);
    expect(admit(undefined)).toBe(1000);
    expect(createAuthRateLimiter(() => 0)(undefined)).toBe(0);
  });

  it("bounds source storage without evicting penalties and reclaims expired entries", () => {
    let fakeNow = 0;
    const admit = createAuthRateLimiter(() => fakeNow);
    for (let attempt = 0; attempt < 5; attempt += 1) expect(admit("192.0.2.1")).toBe(0);
    for (let source = 0; source < 1023; source += 1) expect(admit(`2001:db8::${source.toString(16)}`)).toBe(0);
    expect(admit("192.0.2.2")).toBe(60000);
    expect(admit("192.0.2.1")).toBe(1000);
    expect(admit("2001:db8::0")).toBe(0);
    fakeNow = 10 * 60 * 1000;
    expect(admit("192.0.2.2")).toBe(0);
    expect(admit("192.0.2.1")).toBe(0);
  });
});
