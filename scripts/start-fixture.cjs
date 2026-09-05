const { app, BrowserWindow } = require("electron");
const path = require("node:path");

// Shared CI runners have no usable GPU process; software rendering keeps the
// fixture alive there. Local runs keep hardware acceleration so numbers match the app.
if (process.env.CI) app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    // Let the first renderer frame and lazy-free shell settle before sampling.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await window.webContents.executeJavaScript(`(() => {
      const origin = location.origin;
      const resources = performance.getEntriesByType("resource").map((entry) => ({
        name: entry.name,
        durationMs: Math.round(entry.duration * 100) / 100,
        transferSize: entry.transferSize,
      }));
      // Chromium does not expose file:// resource timings, so include the
      // browser-loaded declarations as a deterministic fallback for the local
      // production fixture.
      const declared = [...document.scripts].map((script) => script.src)
        .concat([...document.querySelectorAll("link[href]")].map((link) => link.href));
      for (const name of declared) {
        if (!resources.some((entry) => entry.name === name)) resources.push({ name, durationMs: 0, transferSize: 0 });
      }
      const paints = performance.getEntriesByType("paint").map((entry) => ({
        name: entry.name,
        startTimeMs: Math.round(entry.startTime * 100) / 100,
      }));
      const externalRequests = resources.filter((entry) => {
        try {
          const url = new URL(entry.name);
          return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin;
        } catch { return false; }
      });
      const overlaySelectors = [".palette-backdrop", ".modal-scrim", ".project-picker-scrim"];
      const overlayStyles = Object.fromEntries(overlaySelectors.map((selector) => {
        const element = document.createElement("div");
        element.className = selector.slice(1);
        document.body.append(element);
        const started = performance.now();
        const style = getComputedStyle(element);
        const measuredMs = performance.now() - started;
        element.remove();
        return [selector, {
          backdropBlur: style.backdropFilter !== "none" && style.backdropFilter !== "",
          measuredMs: Math.round(measuredMs * 100) / 100,
        }];
      }));
      return {
        firstPaintMs: paints.find((entry) => entry.name === "first-paint")?.startTimeMs ?? null,
        firstContentfulPaintMs: paints.find((entry) => entry.name === "first-contentful-paint")?.startTimeMs ?? null,
        paints,
        resources,
        loadedResourceCount: resources.length,
        externalRequests,
        overlayStyles,
      };
    })()`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    window.destroy();
    app.exit(0);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
