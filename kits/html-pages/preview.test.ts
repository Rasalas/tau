import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { createHeadlessPreviewSurface } from "../preview/headless-surface.js";
import { HEADLESS_DOCUMENT_URL } from "../preview/headless-surface.js";
import { PagePreviewer } from "./preview.js";
import { previewHtmlPageTool } from "./tools.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "tau-html-check-"));
  vi.stubEnv("TAU_PREVIEW_BROWSER", "/test/chrome");
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

function world(load: () => Promise<void> = async () => undefined) {
  const surface = {
    place: vi.fn(), setAppearance: vi.fn(), load: vi.fn(load),
    evaluate: vi.fn(async () => HEADLESS_DOCUMENT_URL),
    capture: vi.fn(async () => ({ base64: "cG5n", width: 600, height: 400 })),
    state: () => ({ consoleErrors: Array.from({ length: 60 }, () => "e".repeat(5000)) }),
    destroy: vi.fn(async () => undefined),
  };
  const create = vi.fn(async () => surface) as unknown as ReturnType<typeof vi.fn<typeof createHeadlessPreviewSurface>>;
  const preview = new PagePreviewer({ stateDir: directory, findCommand: () => undefined, noteSubprocess: vi.fn() }, create);
  return { preview, surface, create };
}

it("uses the frame response sandbox, bounds evidence and leaves no stored page or profile", async () => {
  const w = world();
  const page = await w.preview.render({ cwd: directory }, { title: "Plot", html: "<p>plot</p>", origins: ["https://cdn.example.com"], width: 600, height: 400, colorScheme: "dark" });
  expect(page.consoleErrors).toHaveLength(20);
  expect(page.consoleErrors.every((line) => line.length === 2000)).toBe(true);
  const [options, executable, profile, document] = w.create.mock.calls[0]!;
  expect(options.workspaceRoot()).toBe("");
  expect(executable).toBe("/test/chrome");
  expect(profile).toContain(join(directory, "html-preview-"));
  expect(document!.contentSecurityPolicy).toContain("sandbox allow-scripts allow-forms;");
  expect(document!.contentSecurityPolicy).toContain("connect-src 'none'");
  expect(document!.contentSecurityPolicy).toContain("https://cdn.example.com");
  expect(document!.html).toContain("<p>plot</p>");
  expect(document!.html).toContain('r.style.colorScheme="dark"');
  expect(w.surface.place).toHaveBeenCalledWith({ x: 0, y: 0, width: 600, height: 400 }, false);
  expect(w.surface.destroy).toHaveBeenCalledOnce();
  expect(await readdir(directory)).toEqual([]);
});

it("closes a failed capture before releasing the next browser", async () => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => { release = resolve; });
  const w = world(() => loaded);
  w.surface.capture.mockRejectedValueOnce(new Error("renderer failed"));
  const first = w.preview.render({ cwd: directory }, { title: "First", html: "<p>1</p>" });
  const failed = expect(first).rejects.toThrow("renderer failed");
  const second = w.preview.render({ cwd: directory }, { title: "Second", html: "<p>2</p>" });
  await vi.waitFor(() => expect(w.surface.load).toHaveBeenCalledOnce());
  expect(w.create).toHaveBeenCalledOnce();
  release();
  await failed;
  await second;
  expect(w.surface.destroy).toHaveBeenCalledTimes(2);
  expect(w.create.mock.calls[0]![2]).not.toBe(w.create.mock.calls[1]![2]);
  expect(await readdir(directory)).toEqual([]);
});

it("cancels queued previews on deactivation without starting another browser", async () => {
  let release!: () => void;
  const w = world(() => new Promise<void>((resolve) => { release = resolve; }));
  const first = w.preview.render({ cwd: directory }, { title: "First", html: "<p>1</p>" });
  const firstStopped = expect(first).rejects.toThrow(/stopped/u);
  const second = w.preview.render({ cwd: directory }, { title: "Second", html: "<p>2</p>" });
  const secondStopped = expect(second).rejects.toThrow();
  await vi.waitFor(() => expect(w.surface.load).toHaveBeenCalledOnce());
  const disposed = w.preview.dispose();
  expect(w.surface.destroy).toHaveBeenCalled();
  release();
  await Promise.all([firstStopped, secondStopped, disposed]);
  expect(w.create).toHaveBeenCalledOnce();
  expect(await readdir(directory)).toEqual([]);
});

it("returns a tool image and diagnostics without a publication marker", async () => {
  const w = world();
  const tool = previewHtmlPageTool((input, signal) => w.preview.render({ cwd: directory }, input, signal));
  const result = await tool.execute("preview", { title: "Chart", html: "<p>chart</p>" }, undefined, undefined, {} as never);
  expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: "cG5n" });
  const text = JSON.stringify(result.content[1]);
  expect(text).toContain("Not published");
  expect(text).not.toContain("[tau-html-page:");
  expect(text.length).toBeLessThan(41_000);
});
