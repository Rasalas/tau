// Real Preview on an isolated Tau host, without Electron, a display or accounts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startTestHost, stopTestHost } from "./tau-test-host.mjs";
import { prepareFakePiAgentDir, startFakeModelServer } from "./fake-model-server.mjs";
import { HostUplink } from "../dist-electron/main/host-uplink.js";

const name = "preview-headless";
const model = await startFakeModelServer();
let typed = "";
let recordedVideo;
let videoProof;
let slowResponse;
let startedDownload;
const downloadStarted = new Promise((resolve) => { startedDownload = resolve; });
const fixture = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture");
  if (url.pathname === "/video-proof") { videoProof = JSON.parse(url.searchParams.get("data")); response.end("ok"); return; }
  if (url.pathname === "/recorded.mp4") { response.setHeader("content-type", "video/mp4"); response.end(recordedVideo); return; }
  if (url.pathname === "/video-check") {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>Recording decoder fixture</title><script>
      (async () => {
        const video = document.createElement('video'); video.muted = true;
        const loaded = new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(Error('Video decode failed')); });
        video.src = URL.createObjectURL(new Blob([await (await fetch('/recorded.mp4')).arrayBuffer()], {type:'video/mp4'}));
        document.body.append(video);
        await loaded;
        const presented = new Promise(resolve => video.requestVideoFrameCallback((_now, metadata) => resolve(metadata)));
        await video.play();
        const firstFrame = await presented;
        video.pause();
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        const sample = () => { context.drawImage(video, video.videoWidth/2, video.videoHeight/2, 1, 1, 0, 0, 1, 1); return [...context.getImageData(0,0,1,1).data]; };
        const first = sample();
        const duration = video.duration;
        if (!Number.isFinite(duration) || duration <= 0) throw Error('Missing video duration');
        await new Promise((resolve, reject) => { video.onseeked = resolve; video.onerror = reject; video.currentTime = Math.max(0.01, duration-0.1); });
        await fetch('/video-proof?data='+encodeURIComponent(JSON.stringify({first,last:sample(),duration,width:video.videoWidth,height:video.videoHeight,firstFrameTime:firstFrame.mediaTime,browser:navigator.userAgent})));
      })().catch(error => fetch('/video-proof?data='+encodeURIComponent(JSON.stringify({error:String(error)}))));
    </script>`);
    return;
  }
  if (url.pathname === "/record-red" || url.pathname === "/record-blue") {
    const color = url.pathname === "/record-red" ? "red" : "blue";
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><style>html,body{margin:0;height:100%;background:${color}}</style><title>Recording ${color} fixture</title><span></span><script>setInterval(()=>document.querySelector('span').textContent=Date.now(),50)</script>`);
    return;
  }
  if (url.pathname === "/typed") { typed = url.searchParams.get("value"); response.end("ok"); return; }
  if (url.pathname === "/slow-download") { slowResponse = response; startedDownload(); return; }
  if (url.pathname === "/download") { response.end(request.headers.cookie?.includes("probe=retained") ? "authenticated" : "anonymous"); return; }
  if (url.pathname === "/login") response.setHeader("set-cookie", "probe=retained; HttpOnly; Max-Age=3600; SameSite=Lax");
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><title>Headless Preview fixture</title>
    <input aria-label="Account" oninput="fetch('/typed?value='+encodeURIComponent(this.value))">
    <script>console.error("synthetic console error")</script>`);
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
let client;
let owned = false;
const guard = setTimeout(() => { console.error("Headless Preview smoke timed out."); process.exitCode = 1; void cleanup(); }, 90_000);
const options = {
  env: { DISPLAY: "", WAYLAND_DISPLAY: "", WAYLAND_SOCKET: "" },
  prepare: (env) => prepareFakePiAgentDir(env.PI_CODING_AGENT_DIR, model.baseUrl),
};
const preview = (command, input) => client.request("host-extension", ["tau.preview", command, input]);
async function until(read, test) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Recording fixture did not reach its expected state.");
}
async function start(fresh) {
  const host = await startTestHost({ name, fresh, kits: true, login: false }, options);
  owned = true;
  client = new HostUplink({ url: host.url, token: (await readFile(host.tokenFile, "utf8")).trim() });
  await client.request("bootstrap");
  // Open a real thread so Preview uses that thread's isolated workspace.
  await client.request("start-thread", [{ cwd: host.workspace, prompt: "say one word", backend: "pi", model: { provider: "tau-fake", id: "fake-1" } }]);
  return host;
}
async function stop(closePreview = true) {
  if (!owned) return;
  if (closePreview) await preview("close").catch(() => undefined);
  client.close();
  client = undefined;
  await stopTestHost(name);
  owned = false;
}
async function cleanup() {
  await stop(false);
  await new Promise((resolve) => fixture.close(resolve));
  await model.close();
}
try {
  let host = await start(true);
  await preview("use-profile", { name: "smoke" });
  await preview("open", { url: `${url}/login` });
  const state = await preview("state");
  assert.equal(state.surface, "headless");
  assert.equal(state.title, "Headless Preview fixture");
  assert.equal(state.noWindow, undefined);
  assert(state.consoleErrors.some((error) => error.includes("synthetic console error")));
  await preview("open", { url: `${url}/login#section` });
  assert.equal((await preview("state")).url, `${url}/login#section`);
  await preview("input", { kind: "click", x: 0.04, y: 0.02 });
  assert.deepEqual(await preview("input", { kind: "text", text: "Ada" }), { focus: "field" });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (typed === "Ada") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(typed, "Ada");
  const frame = await preview("live-frame", { maxWidth: 640, viewer: { id: "smoke", width: 390, height: 844, dpr: 1, touch: true } });
  assert(frame?.data && frame.width > 0 && frame.height > 0);
  assert.equal(Buffer.from(frame.data, "base64").readUInt16BE(0), 0xffd8);
  // Native MP4 encoding, incremental fragments and a navigation in the middle.
  const recordings = join(host.userData, "kit-state", "tau.preview", "recordings");
  await preview("open", { url: `${url}/record-red` });
  assert((await preview("record-start")).recordingSince);
  const [recordingName] = await readdir(recordings);
  assert(recordingName.endsWith(".mp4"));
  const recordingPath = join(recordings, recordingName);
  const redBytes = await until(async () => (await stat(recordingPath)).size, size => size > 100);
  await preview("open", { url: `${url}/record-blue` });
  await until(async () => (await stat(recordingPath)).size, size => size > redBytes + 100);
  const recording = await preview("record-stop");
  assert.equal(recording.mimeType, "video/mp4");
  assert.equal(recording.path, recordingPath);
  recordedVideo = await readFile(recording.path);
  assert.equal(recordedVideo.subarray(4,8).toString(), "ftyp");
  assert.equal(recordedVideo.length, recording.size);
  await preview("open", { url: `${url}/video-check` });
  const proof = await until(async () => videoProof, value => Boolean(value));
  assert(!proof.error, proof.error);
  assert(proof.width > 0 && proof.height > 0 && proof.duration > 0);
  assert(proof.first[0] > 200 && proof.first[2] < 50, JSON.stringify(proof));
  assert(proof.last[2] > 200 && proof.last[0] < 50, JSON.stringify(proof));
  // A static page can be recorded again; closing finalizes and clears the run.
  await preview("open", { url: `${url}/login` });
  await preview("record-start");
  await preview("live-frame", { maxWidth: 640 });
  await preview("close");
  assert.equal((await preview("state")).recordingSince, undefined);
  const savedNames = (await readdir(recordings)).filter(fileName => fileName.endsWith(".mp4"));
  assert.equal(savedNames.length, 2);
  const staticName = savedNames.find(fileName => fileName !== recordingName);
  recordedVideo = await readFile(join(recordings, staticName));
  videoProof = undefined;
  await preview("open", { url: `${url}/video-check` });
  const staticProof = await until(async () => videoProof, value => Boolean(value));
  assert(!staticProof.error, staticProof.error);
  assert(staticProof.width > 0 && staticProof.height > 0 && staticProof.duration > 0);
  await mkdir("reports", { recursive: true });
  await writeFile("reports/preview-headless-recording.json", JSON.stringify({ isolated: true, display: false, audio: false, animated: proof, static: staticProof, container: recording.mimeType, animatedBytes: recording.size, staticBytes: recordedVideo.length, recordingClearedOnClose: true }, null, 2));
  await preview("open", { url: `${url}/login` });
  await preview("download", { url: `${url}/download`, destination: "report.txt" });
  assert.equal(await readFile(join(host.workspace, "report.txt"), "utf8"), "authenticated");
  await assert.rejects(preview("download", { url: `${url}/download`, destination: "report.txt" }));
  await assert.rejects(preview("download", { url: `${url}/download`, destination: "../escape.txt" }), /outside the workspace/u);
  const downloading = preview("download", { url: `${url}/slow-download`, destination: "original-workspace.txt" });
  await downloadStarted;
  const otherWorkspace = join(host.workspace, "other");
  await mkdir(otherWorkspace, { recursive: true });
  await client.request("start-thread", [{ cwd: otherWorkspace, prompt: "say one word", backend: "pi", model: { provider: "tau-fake", id: "fake-1" } }]);
  slowResponse.end("bound to original workspace");
  await downloading;
  assert.equal(await readFile(join(host.workspace, "original-workspace.txt"), "utf8"), "bound to original workspace");
  await assert.rejects(access(join(otherWorkspace, "original-workspace.txt")));
  await stop(false);
  host = await start(false);
  await preview("open", { url: `${url}/check` });
  await preview("download", { url: `${url}/download`, destination: "after-restart.txt" });
  assert.equal(await readFile(join(host.workspace, "after-restart.txt"), "utf8"), "authenticated");
  await preview("delete-profile", { id: "smoke" });
  await preview("use-profile", { name: "smoke" });
  await preview("download", { url: `${url}/download`, destination: "after-delete.txt" });
  assert.equal(await readFile(join(host.workspace, "after-delete.txt"), "utf8"), "anonymous");
  const offline = join(host.workspace, "offline.html");
  await writeFile(offline, "<title>Offline Preview fixture</title><p>local content</p>");
  await preview("open", { url: pathToFileURL(offline).href });
  assert.equal((await preview("state")).title, "Offline Preview fixture");
  const outside = join(host.workspace, "..", "outside.html");
  await writeFile(outside, "<title>Private content</title>");
  await assert.rejects(preview("open", { url: pathToFileURL(outside).href }), /workspace/u);
  console.log("Headless Preview passed: real Tau host, no display, trusted input, live JPEG, console errors, authenticated downloads, no overwrite, retained and deleted profiles, restart, offline files, workspace confinement and decoded MP4 video across navigation with incremental fragments, restart and close.");
} finally { clearTimeout(guard); await cleanup(); }
