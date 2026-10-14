const { app, BrowserWindow } = require("electron");
const path = require("node:path");

// Shared CI runners have no usable GPU process; software rendering keeps the
// fixture alive there. Local runs keep hardware acceleration so numbers match the app.
if (process.env.CI) app.disableHardwareAcceleration();
// No Dock icon and no activation while the user works; TAU_FOREGROUND=1 opts out.
if (process.platform === "darwin" && process.env.TAU_FOREGROUND !== "1") app.setActivationPolicy("accessory");

const scenario = process.argv[2];
if (!scenario) throw new Error("renderer benchmark scenario is required");
const scenarioConfig = process.argv[3] ? JSON.parse(process.argv[3]) : {};
app.commandLine.appendSwitch("enable-precise-memory-info");

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  const rendererErrors = [];
  window.webContents.on("console-message", (details) => {
    if (details.level === "error") rendererErrors.push(details.message);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    rendererErrors.push(`renderer process gone: ${details.reason}, exit ${details.exitCode}`);
  });
  try {
    // Linux software rendering can stop delivering animation frames to an
    // unmapped window even with background throttling disabled. Map it on CI's
    // Xvfb display before loading; local benchmarks still stay out of sight.
    if (process.env.CI) window.showInactive();
    await window.loadFile(path.join(__dirname, "..", "dist-benchmark", "index.html"), {
      query: { rendererBenchmark: "1", scenario, config: JSON.stringify(scenarioConfig) },
    });
    const deadline = Date.now() + 30_000;
    let result;
    while (Date.now() < deadline) {
      result = await window.webContents.executeJavaScript("window.__TAU_RENDERER_BENCHMARK__", true);
      if (result) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!result) {
      const state = await window.webContents.executeJavaScript(`JSON.stringify({
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        diffStackProgress: window.__TAU_DIFF_STACK_PROGRESS__,
        domNodes: document.getElementsByTagName("*").length,
        contentCharacters: document.body.textContent?.length ?? 0,
      })`).catch((error) => JSON.stringify({ inspectionError: error.message }));
      throw new Error(`renderer benchmark timed out: ${scenario}; state=${state}; rendererErrors=${JSON.stringify(rendererErrors)}`);
    }
    result.electronVersion = process.versions.electron;
    result.gpuFeatureStatus = app.getGPUFeatureStatus();
    try {
      result.gpuInfo = await app.getGPUInfo("complete");
    } catch {
      result.gpuInfo = undefined;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    window.destroy();
  }
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
