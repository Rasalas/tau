const { app, BrowserWindow } = require("electron");
const path = require("node:path");

// Shared CI runners have no usable GPU process; software rendering keeps the
// fixture alive there. Local runs keep hardware acceleration so numbers match the app.
if (process.env.CI) app.disableHardwareAcceleration();

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
  try {
    await window.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
      query: { rendererBenchmark: "1", scenario, config: JSON.stringify(scenarioConfig) },
    });
    const deadline = Date.now() + 30_000;
    let result;
    while (Date.now() < deadline) {
      result = await window.webContents.executeJavaScript("window.__TAU_RENDERER_BENCHMARK__", true);
      if (result) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!result) throw new Error(`renderer benchmark timed out: ${scenario}`);
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
    app.exit(0);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
