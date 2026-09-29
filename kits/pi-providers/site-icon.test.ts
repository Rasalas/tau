import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSiteIcon, isInertSvg, isLocalProvider, isPrivateAddress, linkedIcons, MAX_ICON_BYTES, SiteIconCache, sniffImage } from "./site-icon";

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#123"/></svg>`;

type Route = { status?: number; type?: string; body?: string | Buffer; location?: string };

let server: Server | undefined;
let requests: string[] = [];

/** A site on 127.0.0.1 with the given pages; every request path is recorded. */
async function site(routes: Record<string, Route>): Promise<string> {
  requests = [];
  server = createServer((request, response) => {
    requests.push(request.url ?? "");
    const route = routes[(request.url ?? "").split("?")[0]!];
    if (!route) { response.writeHead(404).end(); return; }
    response.writeHead(route.status ?? 200, { ...(route.type ? { "content-type": route.type } : {}), ...(route.location ? { location: route.location } : {}) });
    response.end(route.body ?? "");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("addresses", () => {
  it("counts loopback, private, shared, link-local and mapped addresses as private", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.10", "169.254.1.1", "100.100.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:192.168.0.1", "not-an-ip"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "1.1.1.1", "2606:4700::1111", "172.32.0.1"]) expect(isPrivateAddress(address), address).toBe(false);
  });

  it("calls a provider local when its host is, by name, by address or by what it resolves to", async () => {
    const resolve = async (host: string) => (host === "llm.lan" ? ["192.168.1.5"] : ["93.184.216.34"]);
    expect(await isLocalProvider("http://localhost:1234/v1", resolve)).toBe(true);
    expect(await isLocalProvider("http://127.0.0.1:11434", resolve)).toBe(true);
    expect(await isLocalProvider("https://llm.lan/v1", resolve)).toBe(true);
    expect(await isLocalProvider("https://api.example.com/v1", resolve)).toBe(false);
  });
});

describe("what counts as an icon", () => {
  it("types a body by its bytes, not by what the server says", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0]))).toBe("image/x-icon");
    expect(sniffImage(Buffer.from(`<?xml version="1.0"?>\n${SVG}`))).toBe("image/svg+xml");
    expect(sniffImage(Buffer.from("<!doctype html><html></html>"))).toBeUndefined();
  });

  it("takes an SVG that only draws and refuses one that does anything else", () => {
    expect(isInertSvg(SVG)).toBe(true);
    expect(isInertSvg(`<svg><use href="#a"/><rect fill="url(#g)"/></svg>`)).toBe(true);
    for (const svg of [
      `<svg><script>alert(1)</script></svg>`,
      `<svg onload="alert(1)"></svg>`,
      `<svg><image href="https://tracker.example/p.png"/></svg>`,
      `<svg><use xlink:href="other.svg#a"/></svg>`,
      `<svg><rect style="fill:url(https://x.example/a)"/></svg>`,
      `<svg><foreignObject><div/></foreignObject></svg>`,
      `<!DOCTYPE svg [<!ENTITY x "y">]><svg/>`,
    ]) expect(isInertSvg(svg), svg).toBe(false);
  });

  it("prefers a scalable or large linked icon, then a touch icon", () => {
    const page = new URL("https://example.com/");
    const html = `<link rel="apple-touch-icon" href="/touch.png"><link rel="icon" href="/16.png" sizes="16x16"><link rel="icon" href="/64.png" sizes="64x64"><link rel="icon" type="image/svg+xml" href="/mark.svg"><link rel="icon" href="javascript:x">`;
    expect(linkedIcons(html, page).map((url) => url.pathname)).toEqual(["/mark.svg", "/64.png", "/16.png", "/touch.png"]);
  });
});

describe("fetching a site icon", () => {
  it("asks the origin only, never the API's path or query, and returns the linked icon", async () => {
    const origin = await site({ "/": { type: "text/html", body: `<link rel="icon" href="/brand.svg">` }, "/brand.svg": { type: "image/svg+xml", body: SVG } });
    const icon = await fetchSiteIcon(`${origin}/v1/chat?key=secret`, { allowPrivate: true });
    expect(icon).toBe(`data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`);
    expect(requests).toEqual(["/", "/brand.svg"]);
  });

  it("falls back to /favicon.ico, following a redirect, and types it by its bytes", async () => {
    const origin = await site({ "/favicon.ico": { status: 302, location: "/assets/icon" }, "/assets/icon": { type: "text/plain", body: PNG } });
    expect(await fetchSiteIcon(origin, { allowPrivate: true })).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  it("skips what is not an image, too large, or an SVG that does more than draw", async () => {
    const origin = await site({
      "/": { type: "text/html", body: `<link rel="icon" href="/evil.svg"><link rel="icon" href="/page.png" sizes="32x32"><link rel="icon" href="/huge.png" sizes="16x16">` },
      "/evil.svg": { type: "image/svg+xml", body: `<svg onload="fetch('//x')"/>` },
      "/page.png": { type: "image/png", body: "<html>not an image</html>" },
      "/huge.png": { type: "image/png", body: Buffer.concat([PNG, Buffer.alloc(MAX_ICON_BYTES)]) },
    });
    expect(await fetchSiteIcon(origin, { allowPrivate: true })).toBeUndefined();
  });

  it("gives up after three redirects", async () => {
    const origin = await site({ "/favicon.ico": { status: 302, location: "/a" }, "/a": { status: 302, location: "/b" }, "/b": { status: 302, location: "/c" }, "/c": { status: 302, location: "/d" }, "/d": { type: "image/png", body: PNG } });
    await expect(fetchSiteIcon(origin, { allowPrivate: true })).rejects.toThrow(/too many redirects/u);
  });

  it("never reaches a private address for a provider that is not local", async () => {
    const origin = await site({ "/favicon.ico": { type: "image/png", body: PNG } });
    const port = new URL(origin).port;
    await expect(fetchSiteIcon(origin, { allowPrivate: false })).rejects.toThrow(/private address/u);
    // A public name that resolves to this machine is refused where the socket connects.
    await expect(fetchSiteIcon(`http://icons.example:${port}`, { allowPrivate: false, resolve: async () => ["127.0.0.1"] })).rejects.toThrow(/private address/u);
    expect(requests).toEqual([]);
  });

  it("refuses anything but http and https", async () => {
    await expect(fetchSiteIcon("file:///etc/passwd", { allowPrivate: true })).rejects.toThrow(/not http/u);
  });
});

describe("the cache", () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it("fetches an origin once, again when asked fresh or stale, and keeps it on disk", async () => {
    dir = await mkdtemp(join(tmpdir(), "tau-site-icons-"));
    let now = 1_000;
    const fetchIcon = vi.fn(async () => "data:image/png;base64,AA==");
    const cache = new SiteIconCache(join(dir, "site-icons.json"), fetchIcon, () => now);
    const [first, second] = await Promise.all([cache.icon("https://api.example.com/v1", { local: false }), cache.icon("https://api.example.com/v2", { local: false })]);
    expect([first, second]).toEqual(["data:image/png;base64,AA==", "data:image/png;base64,AA=="]);
    expect(fetchIcon).toHaveBeenCalledTimes(1);
    expect(fetchIcon).toHaveBeenCalledWith("https://api.example.com", false);
    await cache.icon("https://api.example.com", { local: false, fresh: true });
    expect(fetchIcon).toHaveBeenCalledTimes(2);
    now += 31 * 24 * 60 * 60 * 1000;
    await cache.icon("https://api.example.com", { local: false });
    expect(fetchIcon).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await readFile(join(dir, "site-icons.json"), "utf8"))).toEqual({ "https://api.example.com": { image: "data:image/png;base64,AA==", checkedAt: now } });
    const reopened = new SiteIconCache(join(dir, "site-icons.json"), fetchIcon, () => now);
    expect(await reopened.icon("https://api.example.com", { local: false })).toBe("data:image/png;base64,AA==");
    expect(fetchIcon).toHaveBeenCalledTimes(3);
  });
});
