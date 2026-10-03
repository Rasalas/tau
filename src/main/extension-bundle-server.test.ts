import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }));

const { DesktopBundleStore } = await import("./extension-bundle-server.js");

describe("tau-ext bundle scheme", () => {
  it("serves a published bundle as JavaScript and nothing else", async () => {
    const store = new DesktopBundleStore();
    const url = store.publish("acme.pkg", "export default 1;");
    expect(url).toMatch(/^tau-ext:\/\/bundles\/acme\.pkg\/[0-9a-f]{32}\.js$/u);

    const served = store.respond(url);
    expect(served.status).toBe(200);
    expect(served.headers.get("Content-Type")).toBe("text/javascript");
    await expect(served.text()).resolves.toBe("export default 1;");

    expect(store.respond("tau-ext://bundles/acme.pkg/deadbeef.js").status).toBe(404);
    expect(store.respond("tau-ext://bundles/other.pkg/00000000000000000000000000000000.js").status).toBe(404);
    expect(store.respond("tau-ext://elsewhere/acme.pkg/x.js").status).toBe(404);
    // No path outside the published set, however it is spelled.
    expect(store.respond("tau-ext://bundles/../../etc/passwd").status).toBe(404);
    expect(store.respond("not a url").status).toBe(404);
  });

  it("serves a published stylesheet as CSS, beside the bundle of the same extension", async () => {
    const store = new DesktopBundleStore();
    const url = store.publishStyles("acme.pkg", ".acme { color: red; }");
    expect(url).toMatch(/^tau-ext:\/\/bundles\/acme\.pkg\/[0-9a-f]{32}\.css$/u);

    const served = store.respond(url);
    expect(served.headers.get("Content-Type")).toBe("text/css");
    await expect(served.text()).resolves.toBe(".acme { color: red; }");

    // Same bytes, different kind: neither URL serves the other's content.
    const script = store.publish("acme.pkg", ".acme { color: red; }");
    expect(script).not.toBe(url);
    expect(store.respond(script).headers.get("Content-Type")).toBe("text/javascript");
  });

  it("lets the file:// workbench import a bundle across origins", async () => {
    const { protocol } = await import("electron");
    const { registerDesktopBundleScheme } = await import("./extension-bundle-server.js");
    registerDesktopBundleScheme();
    const [schemes] = vi.mocked(protocol.registerSchemesAsPrivileged).mock.lastCall!;
    expect(schemes[0]!.privileges).toMatchObject({ corsEnabled: true });

    const store = new DesktopBundleStore();
    expect(store.respond(store.publish("acme.pkg", "export default 1;")).headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(store.respond(store.publishStyles("acme.pkg", ".a {}")).headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("gives the same content one URL and forgets everything on a reload", () => {
    const store = new DesktopBundleStore();
    expect(store.publish("acme.pkg", "a")).toBe(store.publish("acme.pkg", "a"));
    expect(store.publish("acme.pkg", "a")).not.toBe(store.publish("acme.pkg", "b"));
    const url = store.publish("acme.pkg", "a");
    store.clear();
    expect(store.respond(url).status).toBe(404);
  });

  it("keeps an unusable extension id inside its own path segment", () => {
    const store = new DesktopBundleStore();
    expect(store.publish("../../etc", "x")).toMatch(/^tau-ext:\/\/bundles\/etc\//u);
    expect(store.publish("", "x")).toMatch(/^tau-ext:\/\/bundles\/extension\//u);
  });

  it("stops serving a bundle after the extension is removed, and leaves other extensions alone", () => {
    const store = new DesktopBundleStore();
    const urlA = store.publish("acme.pkg", "module A");
    const urlB = store.publish("other.pkg", "module B");

    store.remove("acme.pkg");

    expect(store.respond(urlA).status).toBe(404);
    // The other extension's bundle is unaffected.
    expect(store.respond(urlB).status).toBe(200);
  });

  it("lets the page load scripts from tau-ext and no longer from blob URLs", () => {
    const html = readFileSync(fileURLToPath(new URL("../renderer/index.html", import.meta.url)), "utf8");
    const csp = /content="([^"]+)"/u.exec(html.split("Content-Security-Policy")[1] ?? "")?.[1] ?? "";
    expect(csp).toContain("script-src 'self' tau-ext:");
    // Kits link their stylesheets from the same scheme.
    expect(csp).toContain("style-src 'self' 'unsafe-inline' tau-ext:");
    expect(csp).not.toContain("blob:");
  });

  it("lets a frame, an image and a media element load the workspace files shared over tau-ext", () => {
    const html = readFileSync(fileURLToPath(new URL("../renderer/index.html", import.meta.url)), "utf8");
    const csp = /content="([^"]+)"/u.exec(html.split("Content-Security-Policy")[1] ?? "")?.[1] ?? "";
    expect(csp).toContain("img-src 'self' data: tau-ext: https:");
    expect(csp).toContain("media-src 'self' tau-ext: https:");
    expect(csp).toContain("frame-src 'self' tau-ext:");
  });
});
