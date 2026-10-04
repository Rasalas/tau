// Bundle to .tau-dev/preview-window-lifecycle/probe.cjs and run with Electron.
import { app, BrowserWindow } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import activatePreviewWindowHalf from "./view.js";

const root = join(process.cwd(), ".tau-dev", "preview-window-lifecycle");
app.setPath("userData", join(root, "userData"));
const deadline = setTimeout(() => app.exit(1), 20_000);
app.on("window-all-closed", () => undefined);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZuoAAAAASUVORK5CYII=", "base64");
const server = createServer((request, response) => {
  if (request.url?.endsWith(".png")) {
    response.setHeader("Content-Type", "image/png");
    response.end(png);
  } else {
    response.setHeader("Content-Type", "text/html");
    response.end('<h1>Screenshot gallery fixture</h1><img src="/1.png"><img src="/2.png"><img src="/3.png">');
  }
});
void (async () => {
  await app.whenReady();
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  const half = activatePreviewWindowHalf({ id: "tau.preview", invokeHost: async () => undefined, log() {} });
  try {
    assert.throws(() => half.handle("open-view"), /Open the Tau desktop app on the thread's home machine.*Preview.*phone or browser/u);
    console.log("PASS no window returns an actionable host-preview explanation");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await half.handle("load", { url: `http://127.0.0.1:${port}/gallery.html`, workspaceRoot: root });
    const page = await half.handle("evaluate", { expression: "document.querySelector('h1').textContent" }) as { result: string };
    assert.equal(page.result, "Screenshot gallery fixture");
    const images = await half.handle("evaluate", { expression: "Array.from(document.images, image => image.complete && image.naturalWidth > 0)" }) as { result: boolean[] };
    assert.deepEqual(images.result, [true, true, true]);
    half.handle("place", { rect: { x: 0, y: 0, width: 640, height: 480 }, visible: false });
    const frame = await half.handle("capture", { maxWidth: 640 }) as { result: { base64: string; width: number; height: number } };
    assert.ok(frame.result.base64.length > 0);
    assert.ok(frame.result.width > 0 && frame.result.height > 0);
    assert.equal(window.isFocused(), false);
    console.log("PASS a supported host window loads the loopback gallery without focus");
    window.destroy();
    assert.throws(() => half.handle("open-view"), /Open the Tau desktop app on the thread's home machine/u);
    const replacement = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await half.handle("load", { url: `http://127.0.0.1:${port}/gallery.html` });
    const reopened = await half.handle("evaluate", { expression: "document.querySelector('h1').textContent" }) as { result: string };
    assert.equal(reopened.result, "Screenshot gallery fixture");
    console.log("PASS reopening the host window rebuilds the preview");
    half.dispose?.();
    replacement.destroy();
    app.exit(0);
  } finally {
    half.dispose?.();
    server.close();
    clearTimeout(deadline);
  }
})().catch((error: unknown) => { console.error(error); app.exit(1); });
