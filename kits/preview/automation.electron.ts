// Run with Electron after bundling to .tau-dev/preview-automation/probe.cjs.
import { app, BrowserWindow, session } from "electron";
import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { createElectronPreviewSurface } from "./view.js";
import { pageCall, previewClick, previewFind, previewType } from "./page-script.js";

const root = join(process.cwd(), ".tau-dev", "preview-automation");
app.setPath("userData", join(root, "userData"));
const deadline = setTimeout(() => { console.error("probe timed out"); app.exit(1); }, 30_000);
let finishHuman: (() => void) | undefined;
let finishRace: (() => void) | undefined;
const server = createServer((req, res) => {
  if (req.url !== "/") {
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="fixture.txt"' });
    if (req.url === "/human") {
      res.write("temporary download ");
      finishHuman = () => res.end("fixture\n");
    } else if (req.url === "/race") {
      res.write("temporary download ");
      finishRace = () => res.end("fixture\n");
    } else res.end("temporary download fixture\n");
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end('<input id="field"><button id="button" onclick="this.textContent=\'clicked\'">click</button><a id="download" href="/download">download</a>');
  }
});
void (async () => {
  await mkdir(root, { recursive: true });
  await app.whenReady();
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  window.showInactive();
  await window.loadURL("data:text/html,<textarea id='composer'></textarea>");
  await window.webContents.executeJavaScript("document.querySelector('textarea').focus()");
  const partition = "preview-automation-fixture";
  const surface = createElectronPreviewSurface({ partition, onChange() {}, workspaceRoot: () => root, log() {} })!;
  try {
    surface.place({ x: 300, y: 0, width: 400, height: 300 }, false);
    await surface.load(`http://127.0.0.1:${address.port}`, 5_000);
    const composer = () => window.webContents.executeJavaScript("document.activeElement.id");
    const click = await surface.evaluate(pageCall(previewClick, previewFind, { selector: "#button" })) as { ok: boolean };
    assert.equal(click.ok, true);
    assert.equal(await surface.evaluate("document.querySelector('#button').textContent"), "clicked");
    assert.equal(await composer(), "composer", "agent click stole composer focus");
    await surface.evaluate(pageCall(previewType, previewFind, { selector: "#field" }, "agent", false));
    assert.equal(await composer(), "composer", "agent type stole composer focus");
    await surface.pressKey("x");
    assert.equal(await composer(), "composer", "agent key stole composer focus");
    assert.equal(await surface.evaluate("document.querySelector('#field').value"), "agentx", "hidden agent key did not reach field");
    console.log("PASS hidden click/type/key preserve composer focus");
    const at = await surface.evaluate("(() => { window.clicks = 0; const button = document.querySelector('#button'); button.addEventListener('click', () => window.clicks++); const r = button.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()") as { x: number; y: number };
    await Promise.all([surface.input!({ kind: "click", ...at }), surface.input!({ kind: "click", ...at })]);
    assert.equal(await surface.evaluate("window.clicks"), 2, "concurrent clicks were interleaved");
    assert.equal(await composer(), "composer");
    console.log("PASS concurrent input remains two complete clicks");
    const missing = await surface.evaluate(pageCall(previewClick, previewFind, { selector: "#missing" })) as { ok: boolean };
    assert.equal(missing.ok, false);
    await window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await window.webContents.executeJavaScript("document.querySelector('textarea').focus()");
    await Promise.all([
      surface.input!({ kind: "text", text: " page" }),
      window.webContents.debugger.sendCommand("Input.insertText", { text: "human draft" }),
    ]);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('textarea').value"), "human draft");
    assert.equal(await composer(), "composer");
    assert.equal(window.isFocused(), false, "probe became the key window");
    console.log("PASS failed click and concurrent composer typing preserve draft");
    for (const visible of [true, false]) {
      surface.place({ x: 300, y: 0, width: 400, height: 300 }, visible);
      await surface.evaluate(pageCall(previewType, previewFind, { selector: "#field" }, "background", false));
      await surface.pressKey("y");
      assert.equal(await surface.evaluate("document.querySelector('#field').value"), "backgroundy");
      assert.equal(await composer(), "composer");
      assert.equal(window.isFocused(), false);
    }
    window.hide();
    await surface.input!({ kind: "text", text: " hidden" });
    assert.equal(await surface.evaluate("document.querySelector('#field').value"), "backgroundy hidden");
    assert.equal(await composer(), "composer");
    window.showInactive();
    console.log("PASS shown background and hidden-window input preserve composer");

    const downloads = join(root, "downloads");
    await mkdir(downloads, { recursive: true });
    const target = join(downloads, "fixture.txt");
    await rm(target, { force: true });
    const previewSession = session.fromPartition(partition);
    // A fixture-owned destination prevents a native Save dialog in this baseline probe.
    const completed = new Promise<string>((resolve) => {
      previewSession.once("will-download", (_event, item) => {
        item.setSavePath(target);
        item.once("done", (_doneEvent, state) => resolve(state));
      });
    });
    await surface.evaluate(pageCall(previewClick, previewFind, { selector: "#download" }));
    assert.equal(await completed, "completed");
    assert.equal(await readFile(target, "utf8"), "temporary download fixture\n");
    assert.equal(await composer(), "composer");
    console.log("PASS real temporary download with explicit fixture destination");
    const explicit = join(downloads, "explicit.txt");
    await rm(explicit, { force: true });
    await surface.download!(`http://127.0.0.1:${address.port}/download`, explicit);
    assert.equal(await readFile(explicit, "utf8"), "temporary download fixture\n");
    await assert.rejects(() => surface.download!(`http://127.0.0.1:${address.port}/download`, explicit), /exist/i);
    assert.equal(await readFile(explicit, "utf8"), "temporary download fixture\n");
    assert.equal(await composer(), "composer");
    console.log("PASS explicit download completes without dialog or overwrite");
    const humanTarget = join(downloads, "human-choice.txt");
    await rm(humanTarget, { force: true });
    let humanStarted!: () => void;
    const humanReady = new Promise<void>((resolve) => { humanStarted = resolve; });
    const humanDone = new Promise<string>((resolve) => {
      const choose = (_event: Electron.Event, item: Electron.DownloadItem) => {
        if (!item.getURL().endsWith("/human")) return;
        previewSession.off("will-download", choose);
        item.setSavePath(humanTarget);
        item.once("done", (_doneEvent, state) => resolve(state));
        humanStarted();
      };
      previewSession.on("will-download", choose);
    });
    // A regular page download retains the destination chosen by the fixture's stand-in for a human.
    await surface.evaluate(`document.querySelector('#download').href = 'http://127.0.0.1:${address.port}/human'; document.querySelector('#download').click()`);
    await humanReady;
    const otherTarget = join(downloads, "concurrent.txt");
    await rm(otherTarget, { force: true });
    await surface.download!(`http://127.0.0.1:${address.port}/download`, otherTarget);
    finishHuman!();
    assert.equal(await humanDone, "completed");
    assert.equal(await readFile(humanTarget, "utf8"), "temporary download fixture\n");
    await assert.rejects(() => surface.download!(`http://127.0.0.1:${address.port}/download`, "../../outside.txt"), /outside/);
    await assert.rejects(() => surface.download!("file:///etc/passwd", join(downloads, "refused.txt")), /http/);
    const cancel = (_event: Electron.Event, item: Electron.DownloadItem) => { if (item.getURL().endsWith('/cancel')) item.cancel(); };
    previewSession.on("will-download", cancel);
    try {
      await assert.rejects(() => surface.download!(`http://127.0.0.1:${address.port}/cancel`, join(downloads, "cancelled.txt")), /cancelled/);
    } finally { previewSession.off("will-download", cancel); }
    await assert.rejects(() => access(join(downloads, "cancelled.txt")), { code: "ENOENT" });
    const raceTarget = join(downloads, "human-created.txt");
    await rm(raceTarget, { force: true });
    const raceReady = new Promise<void>((resolve) => {
      const ready = (_event: Electron.Event, item: Electron.DownloadItem) => {
        if (!item.getURL().endsWith("/race")) return;
        previewSession.off("will-download", ready);
        resolve();
      };
      previewSession.on("will-download", ready);
    });
    const race = surface.download!(`http://127.0.0.1:${address.port}/race`, raceTarget);
    const refused = assert.rejects(() => race, { code: "EEXIST" });
    await raceReady;
    await writeFile(raceTarget, "human-owned contents");
    finishRace!();
    await refused;
    assert.equal(await readFile(raceTarget, "utf8"), "human-owned contents");
    console.log("PASS page download choice, cancellation, and concurrent human file creation are preserved");
    console.log(JSON.stringify({ pid: process.pid, platform: process.platform, arch: process.arch, versions: process.versions }));
  } finally {
    surface.destroy();
    window.destroy();
    server.close();
    clearTimeout(deadline);
  }
  app.quit();
})().catch((error) => { console.error(error); server.close(); clearTimeout(deadline); app.exit(1); });
