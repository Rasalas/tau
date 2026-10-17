import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createHeadlessPreviewSurface } from "./headless-surface.js";

const backend = vi.hoisted(() => ({ construct: vi.fn() }));
vi.mock("./browser-process.js", () => ({
  PreviewBrowserProcess: class { constructor() { return backend.construct(); } },
}));

it("closes the browser on abort before its first startup command has returned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-browser-start-"));
  const controller = new AbortController();
  let started!: () => void, failVersion!: (error: Error) => void, finishExit!: () => void;
  const starting = new Promise<void>((resolve) => { started = resolve; });
  const version = new Promise<never>((_resolve, reject) => { failVersion = reject; });
  const exited = new Promise<void>((resolve) => { finishExit = resolve; });
  const close = vi.fn(async () => { failVersion(new Error("browser stopped")); finishExit(); });
  backend.construct.mockReturnValue({ send: () => { started(); return version; }, onEvent: vi.fn(), exited, close });
  const opening = createHeadlessPreviewSurface({ partition: "persist:tau-preview", workspaceRoot: () => "", onChange: () => undefined, log: () => undefined, signal: controller.signal }, "/test/browser", directory);
  const stopped = expect(opening).rejects.toThrow("browser stopped");
  try {
    await starting;
    controller.abort();
    // The abort event must own cleanup already; no surface has been returned.
    expect(close).toHaveBeenCalled();
  } finally {
    await close();
    await stopped;
    await rm(directory, { recursive: true, force: true });
  }
});
