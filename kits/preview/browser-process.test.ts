import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PreviewBrowserProcess } from "./browser-process.js";

it("rejects pending commands when the browser executable cannot start", async () => {
  const browser = new PreviewBrowserProcess(join(tmpdir(), `missing-browser-${randomUUID()}`), join(tmpdir(), "unused-preview-profile"));
  await expect(browser.send("Browser.getVersion")).rejects.toThrow(/could not start|pipe closed/u);
  await browser.exited;
  await expect(browser.send("Page.enable")).rejects.toThrow("closed");
  await browser.close();
});

it.skipIf(process.platform === "win32")("waits past the close acknowledgement for normal process exit before confirming persistence", async () => {
  const { browser, remove } = await fakeBrowser("setTimeout(() => process.exit(0), 250)");
  try {
    await browser.send("Browser.getVersion");
    let closed = false;
    const closing = browser.close(true).then(() => { closed = true; });
    await browser.send("Probe.afterCloseAcknowledgement");
    expect(closed).toBe(false);
    await closing;
    await expect(browser.close(true)).resolves.toBeUndefined();
  } finally { await browser.close(); await remove(); }
});

it.skipIf(process.platform === "win32").each(["setTimeout(() => process.exit(1), 30)", "void 0"])("refuses persisted success after abnormal or forced shutdown: %s", async (shutdown) => {
  const { browser, remove } = await fakeBrowser(shutdown);
  try {
    await browser.send("Browser.getVersion");
    await expect(browser.close(true)).rejects.toThrow("did not finish saving");
  } finally { await browser.close(); await remove(); }
});

async function fakeBrowser(shutdown: string) {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "tau-preview-close-test-"));
  const executable = join(root, "fake-browser");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const input = fs.createReadStream('', {fd:3});
let buffer = '';
input.on('data', bytes => {
  buffer += bytes;
  let end;
  while ((end = buffer.indexOf('\\0')) !== -1) {
    const request = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
    fs.writeSync(4, JSON.stringify({id:request.id,result:{}})+'\\0');
    if (request.method === 'Browser.close') { ${shutdown}; }
  }
});
`, { mode: 0o700 });
  return { browser: new PreviewBrowserProcess(executable, join(root, "profile")), remove: () => rm(root, { recursive: true, force: true }) };
}
