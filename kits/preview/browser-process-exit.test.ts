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
