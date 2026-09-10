import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebClientServer, resolveAsset } from "./host-web-server.js";

const root = mkdtempSync(join(tmpdir(), "tau-web-client-"));
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><title>Tau</title>");
writeFileSync(join(root, "assets", "main.js"), "export const ok = 1;\n");

const web = createWebClientServer({ dir: root, token: "s3cret-token", codeTtlMs: 50 });
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

  it("never answers a pairing code to a GET", async () => {
    expect((await fetch(`${origin}/pair`)).status).toBe(405);
  });
});
