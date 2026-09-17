import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthRateLimiter, createWebClientServer, resolveAsset } from "./host-web-server.js";

const root = mkdtempSync(join(tmpdir(), "tau-web-client-"));
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><title>Tau</title>");
writeFileSync(join(root, "assets", "main.js"), "export const ok = 1;\n");

// The shared server keeps the default TTL: a 50 ms window expired under CI load
// before the redeem request arrived. The TTL test below runs its own server.
const web = createWebClientServer({ dir: root, token: "s3cret-token" });
let origin = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => web.server.listen(0, "127.0.0.1", () => resolve()));
  const address = web.server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => web.server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const pair = (code: string) => fetch(`${origin}/pair`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code }),
});

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

describe("the web client a listening host serves", () => {
  it("serves the client at the root and its assets by name", async () => {
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("<title>Tau</title>");

    const asset = await fetch(`${origin}/assets/main.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
  });

  it("serves nothing it was not given", async () => {
    expect((await fetch(`${origin}/nope.js`)).status).toBe(404);
    expect((await fetch(`${origin}/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    expect(resolveAsset("/srv/web", "/assets/a.js")).toBe("/srv/web/assets/a.js");
    expect(resolveAsset("/srv/web", "/")).toBe("/srv/web/index.html");
    // Anything that would leave the built client resolves to nothing at all.
    expect(resolveAsset("/srv/web", "/a/../../etc/passwd")).toBeUndefined();
    expect(resolveAsset("/srv/web", "/../../etc/passwd")).toBeUndefined();
  });

  it("trades a pairing code for the token exactly once", async () => {
    const code = web.issueCode();
    const first = await pair(code);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ token: "s3cret-token" });
    expect((await pair(code)).status).toBe(403);
  });

  it("refuses an invented pairing code", async () => {
    expect((await pair("not-a-code")).status).toBe(403);
  });

  it("refuses a code once the TTL has elapsed", async () => {
    // Use the `now` injection so the test is deterministic and has no real sleep.
    let fakeNow = Date.now();
    const timedWeb = createWebClientServer({ dir: root, token: "s3cret-token", codeTtlMs: 50, now: () => fakeNow });
    await new Promise<void>((resolve) => timedWeb.server.listen(0, "127.0.0.1", () => resolve()));
    const timedAddress = timedWeb.server.address();
    const timedOrigin = `http://127.0.0.1:${typeof timedAddress === "object" && timedAddress ? timedAddress.port : 0}`;
    const timedPair = (code: string) => fetch(`${timedOrigin}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    try {
      const code = timedWeb.issueCode();
      // Advance the clock past the TTL before attempting to redeem.
      fakeNow += 100;
      expect((await timedPair(code)).status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => timedWeb.server.close(() => resolve()));
    }
  });

  it("bounds concurrent malformed pairing attempts and preserves throttled codes", async () => {
    let fakeNow = 0;
    const limited = createWebClientServer({ dir: root, token: "s3cret-token", now: () => fakeNow });
    await new Promise<void>((resolve) => limited.server.listen(0, "127.0.0.1", () => resolve()));
    const address = limited.server.address();
    const limitedOrigin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const post = (body: string, source = "192.0.2.1") => fetch(`${limitedOrigin}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": source, "x-real-ip": source },
      body,
    });
    try {
      const attempts = await Promise.all(Array.from({ length: 30 }, (_, index) => post("{", `192.0.2.${index}`)));
      expect(attempts.filter((response) => response.status === 403)).toHaveLength(20);
      expect(attempts.filter((response) => response.status === 429)).toHaveLength(10);
      const code = limited.issueCode();
      const refused = await post(JSON.stringify({ code }));
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("1");
      expect(await refused.json()).toEqual({ error: "too many pairing attempts" });
      expect((await fetch(`${limitedOrigin}/`)).status).toBe(200);
      expect((await fetch(`${limitedOrigin}/pair`)).status).toBe(405);
      fakeNow = 1000;
      const redeemed = await post(JSON.stringify({ code }));
      expect(redeemed.status).toBe(200);
      expect(await redeemed.json()).toEqual({ token: "s3cret-token" });
      const throttled = await post(JSON.stringify({ code }));
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).toBe("2");
      fakeNow = 3000;
      expect((await post(JSON.stringify({ code }))).status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => limited.server.close(() => resolve()));
    }
  });

  it("never answers a pairing code to a GET", async () => {
    expect((await fetch(`${origin}/pair`)).status).toBe(405);
  });
});
