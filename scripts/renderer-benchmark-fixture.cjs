const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const scenario = process.argv[2];
if (!scenario) throw new Error("renderer benchmark scenario is required");
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
      query: { rendererBenchmark: "1", scenario },
    });
    const deadline = Date.now() + 30_000;
    let result;
    while (Date.now() < deadline) {
      result = await window.webContents.executeJavaScript("window.__TAU_RENDERER_BENCHMARK__", true);
      if (result) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!result) throw new Error(`renderer benchmark timed out: ${scenario}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    window.destroy();
    app.exit(0);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
