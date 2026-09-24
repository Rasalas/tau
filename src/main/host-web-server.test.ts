import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthRateLimiter, createWebClientServer, resolveAsset } from "./host-web-server.js";
import { HostAccess } from "./host-access.js";
import { HostTokenFile } from "./host-token.js";

const root = mkdtempSync(join(tmpdir(), "tau-web-client-"));
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><title>Tau</title>");
writeFileSync(join(root, "assets", "main.js"), "export const ok = 1;\n");

let clock = Date.now();
let access: HostAccess;
let web: ReturnType<typeof createWebClientServer>;
let origin = "";

beforeAll(async () => {
  const tokenFile = new HostTokenFile(join(root, "state", "host-token"));
  access = await HostAccess.open({ tokenFile, storePath: join(root, "state", "paired-clients.json"), now: () => clock });
  web = createWebClientServer({ dir: root, pairing: access });
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

  it("trades a pairing code for a client token of its own, exactly once", async () => {
    const { code } = access.createLink();
    const first = await pair(code);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const { token } = await first.json() as { token: string };
    expect(token).toMatch(/^tauc\.[0-9a-f]{24}\./u);
    // Never the host token: that one stays with the owner.
    expect(access.authenticate(token)).toEqual({ kind: "client", clientId: token.split(".")[1] });
    expect((await pair(code)).status).toBe(403);
  });

  it("refuses an invented pairing code", async () => {
    expect((await pair("not-a-code")).status).toBe(403);
  });

  it("refuses a code once its link has expired", async () => {
    const { code } = access.createLink({ lifetimeMs: 60_000 });
    clock += 60_000;
    expect((await pair(code)).status).toBe(403);
  });

  it("bounds concurrent malformed pairing attempts and preserves throttled codes", async () => {
    let limiterNow = 0;
    const limited = createWebClientServer({ dir: root, pairing: access, now: () => limiterNow });
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
      const { code } = access.createLink();
      const refused = await post(JSON.stringify({ code }));
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("1");
      expect(await refused.json()).toEqual({ error: "too many pairing attempts" });
      expect((await fetch(`${limitedOrigin}/`)).status).toBe(200);
      expect((await fetch(`${limitedOrigin}/pair`)).status).toBe(405);
      limiterNow = 1000;
      const redeemed = await post(JSON.stringify({ code }));
      expect(redeemed.status).toBe(200);
      expect((await redeemed.json() as { token: string }).token).toMatch(/^tauc\./u);
      const throttled = await post(JSON.stringify({ code }));
      expect(throttled.status).toBe(429);
      expect(throttled.headers.get("retry-after")).toBe("2");
      limiterNow = 3000;
      expect((await post(JSON.stringify({ code }))).status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => limited.server.close(() => resolve()));
    }
  });

  it("counts attempts through a proxy apart, strictly, by the address the proxy forwarded", async () => {
    const client = createWebClientServer({ dir: root, pairing: access, now: () => 0 });
    const proxy = createServer(client.handler("proxy"));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const address = proxy.address();
    const proxyOrigin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const post = (target: string, forwarded?: string) => fetch(`${target}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(forwarded ? { "x-forwarded-for": forwarded } : {}) },
      body: "{}",
    });
    await new Promise<void>((resolve) => client.server.listen(0, "127.0.0.1", () => resolve()));
    const own = client.server.address();
    const ownOrigin = `http://127.0.0.1:${typeof own === "object" && own ? own.port : 0}`;
    try {
      // Five for one tailnet peer, not the twenty a loopback peer gets.
      const phone = await Promise.all(Array.from({ length: 6 }, () => post(proxyOrigin, "100.64.0.9")));
      expect(phone.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 429]);
      expect((await post(proxyOrigin, "100.64.0.10")).status).toBe(403);
      // With nothing forwarded every peer is the proxy itself, still held to five.
      const unnamed = await Promise.all(Array.from({ length: 6 }, () => post(proxyOrigin)));
      expect(unnamed.filter((response) => response.status === 429)).toHaveLength(1);
      // This machine's own browser on the loopback listener is untouched by all of it.
      expect((await post(ownOrigin)).status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => client.server.close(() => resolve()));
    }
  });

  it("records the forwarded address of a client that paired through a proxy", async () => {
    const client = createWebClientServer({ dir: root, pairing: access });
    const proxy = createServer(client.handler("proxy"));
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const address = proxy.address();
    try {
      const { code } = access.createLink({ label: "Phone over the tailnet" });
      const response = await fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "100.101.102.103" },
        body: JSON.stringify({ code }),
      });
      expect(response.status).toBe(200);
      expect(access.overview().clients.find((entry) => entry.label === "Phone over the tailnet")?.lastAddress).toBe("100.101.102.103");
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("never answers a pairing code to a GET", async () => {
    expect((await fetch(`${origin}/pair`)).status).toBe(405);
  });
});
