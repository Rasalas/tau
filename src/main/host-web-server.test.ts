import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebClientServer, resolveAsset } from "./host-web-server.js";

const root = mkdtempSync(join(tmpdir(), "tau-web-client-"));
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<!doctype html><title>Tau</title>");
writeFileSync(join(root, "assets", "main.js"), "export const ok = 1;\n");
writeFileSync(join(root, "assets", "tls.wasm"), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
writeFileSync(join(root, "THIRD-PARTY-BROWSER-CONNECT-LICENSES.txt"), "TLS library licenses\n");
writeFileSync(join(root, "manifest.webmanifest"), "{\"name\":\"Tau\"}\n");

let web: ReturnType<typeof createWebClientServer>;
let origin = "";

beforeAll(async () => {
  web = createWebClientServer({ dir: root });
  await new Promise<void>((resolve) => web.server.listen(0, "127.0.0.1", () => resolve()));
  const address = web.server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => web.server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
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
    expect(asset.headers.get("cache-control")).toContain("immutable");
  });

  it("lets the browser revalidate the files that keep their names", async () => {
    const manifest = await fetch(`${origin}/manifest.webmanifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    expect(manifest.headers.get("cache-control")).toBe("no-cache");
  });

  it("serves the TLS adapter for WebAssembly streaming and its license text", async () => {
    const wasm = await fetch(`${origin}/assets/tls.wasm`);
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(wasm.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await wasm.arrayBuffer()).byteLength).toBe(8);
    const licenses = await fetch(`${origin}/THIRD-PARTY-BROWSER-CONNECT-LICENSES.txt`);
    expect(licenses.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await licenses.text()).toContain("TLS library licenses");
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

  it("hands out no credential: pairing is the socket's, where the owner allows each device", async () => {
    const post = await fetch(`${origin}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "abc" }) });
    expect(post.status).toBe(410);
    expect(await post.text()).not.toMatch(/tauc\./u);
    expect((await fetch(`${origin}/pair`)).status).toBe(410);
  });
});
