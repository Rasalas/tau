import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { PreviewBrowserProcess } from "./browser-process.js";

const fakeSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: fakeSpawn }));

it("reports browser exit while a descendant still holds its pipes open", async () => {
  const stderr = new PassThrough(), input = new PassThrough(), output = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, stderr, input, output], stderr,
    exitCode: null as number | null, signalCode: null,
    kill: vi.fn(() => true),
  });
  fakeSpawn.mockReturnValue(child);
  const browser = new PreviewBrowserProcess("/test/chromium", "/test/profile");
  const failed = vi.fn();
  const reply = browser.send("Browser.getVersion").catch(failed);
  try {
    child.exitCode = 1;
    child.emit("exit", 1, null);
    await Promise.resolve();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/exited.*1/u) }));
    await browser.exited;
    expect(input.destroyed).toBe(true);
    expect(output.destroyed).toBe(true);
  } finally {
    child.emit("close", 1, null);
    await reply;
    await browser.close();
    stderr.destroy(); input.destroy(); output.destroy();
  }
});

function fakeChild() {
  const stderr = new PassThrough(), input = new PassThrough(), output = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdio: [null, null, stderr, input, output], stderr,
    exitCode: null as number | null, signalCode: null,
    kill: vi.fn(() => true),
  });
  fakeSpawn.mockReturnValue(child);
  const finish = () => { child.emit("close", 1, null); stderr.destroy(); input.destroy(); output.destroy(); };
  return { child, stderr, finish };
}

it("says Chromium cannot run its sandbox as root, from what the browser printed before it exited", async () => {
  const { child, stderr, finish } = fakeChild();
  const browser = new PreviewBrowserProcess("/test/chromium", "/test/profile");
  const reply = browser.send("Browser.getVersion");
  stderr.write("[1:1:0101/000000:ERROR:zygote_host_impl_linux.cc(1)] Running as root without --no-sandbox is not supported.\n");
  await new Promise((resolve) => setImmediate(resolve));
  child.exitCode = 1;
  child.emit("exit", 1, null);
  try { await expect(reply).rejects.toThrow(/sandbox cannot run as root.*TAU_PREVIEW_NO_SANDBOX=1/u); } finally { finish(); await browser.close(); }
});

it("keeps the sandbox unless asked, and drops it on the explicit opt-in", async () => {
  const argsOf = () => fakeSpawn.mock.calls.at(-1)![1] as string[];
  vi.stubEnv("TAU_PREVIEW_NO_SANDBOX", "");
  let started = fakeChild();
  let browser = new PreviewBrowserProcess("/test/chromium", "/test/profile");
  expect(argsOf()).not.toContain("--no-sandbox");
  started.finish(); await browser.close();
  vi.stubEnv("TAU_PREVIEW_NO_SANDBOX", "1");
  started = fakeChild();
  browser = new PreviewBrowserProcess("/test/chromium", "/test/profile");
  expect(argsOf()).toContain("--no-sandbox");
  started.finish(); await browser.close();
  vi.unstubAllEnvs();
});
