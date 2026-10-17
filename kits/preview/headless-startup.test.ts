import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHeadlessPreviewSurface } from "./headless-surface.js";

it.skipIf(process.platform === "win32")("closes an owned browser on abort while its first startup command is pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-browser-start-"));
  const executable = join(directory, "browser.mjs");
  const started = join(directory, "started");
  await writeFile(executable, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
let buffer = '';
new Socket({fd:3, readable:true, writable:false}).on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\\0')) !== -1) {
    const call = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (call.method === 'Browser.getVersion') writeFileSync(${JSON.stringify(started)}, String(process.pid));
    if (call.method === 'Browser.close') process.exit(0);
  }
});
`);
  await chmod(executable, 0o700);
  const controller = new AbortController();
  let startupError: unknown;
  const opening = createHeadlessPreviewSurface({ partition: "persist:tau-preview", workspaceRoot: () => "", onChange: () => undefined, log: () => undefined, signal: controller.signal }, executable, directory).then(() => "opened", (error: unknown) => { startupError = error; return "stopped"; });
  let timer: NodeJS.Timeout | undefined;
  let pid: number | undefined;
  try {
    await vi.waitFor(async () => { if (startupError) throw startupError; pid = Number(await readFile(started, "utf8")); });
    controller.abort();
    const verdict = await Promise.race([opening, new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still starting"), 750); })]);
    expect(verdict).toBe("stopped");
  } finally {
    clearTimeout(timer);
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* The test browser already exited. */ } }
    await opening;
    await rm(directory, { recursive: true, force: true });
  }
});
