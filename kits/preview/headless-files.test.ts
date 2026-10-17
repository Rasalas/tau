import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { previewFileAllowed, savePreviewDownload } from "./headless-files.js";
import { clearHeadlessPreviewProfile } from "./headless-surface.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const fixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-headless-files-"));
  directories.push(dir);
  const workspace = join(dir, "work");
  await mkdir(workspace);
  return { dir, workspace };
};

it("allows workspace files offline and refuses traversal, siblings and missing roots", async () => {
  const { dir, workspace } = await fixture();
  await writeFile(join(workspace, "page.html"), "ok");
  await writeFile(join(dir, "secret"), "private");
  expect(await previewFileAllowed(pathToFileURL(join(workspace, "page.html")).href, workspace)).toBe(true);
  expect(await previewFileAllowed(pathToFileURL(join(dir, "secret")).href, workspace)).toBe(false);
  expect(await previewFileAllowed(pathToFileURL(join(workspace, "page.html")).href, "")).toBe(false);
  expect(await previewFileAllowed("file:///missing", workspace)).toBe(false);
  expect(await previewFileAllowed("https://example.test", workspace)).toBe(true);
});

it.skipIf(process.platform === "win32")("refuses a symlink out of the workspace for reads and downloads", async () => {
  const { dir, workspace } = await fixture();
  await writeFile(join(dir, "secret"), "private");
  await symlink(join(dir, "secret"), join(workspace, "escape"));
  await symlink(dir, join(workspace, "outside"));
  expect(await previewFileAllowed(pathToFileURL(join(workspace, "escape")).href, workspace)).toBe(false);
  await expect(savePreviewDownload(workspace, "outside/download", Buffer.from("new"))).rejects.toThrow("outside the workspace");
});

it("publishes downloads without replacing an existing file", async () => {
  const { workspace } = await fixture();
  const saved = await savePreviewDownload(workspace, "report.txt", Buffer.from("first"));
  await expect(savePreviewDownload(workspace, "report.txt", Buffer.from("second"))).rejects.toThrow();
  expect(await readFile(saved.path, "utf8")).toBe("first");
  await expect(savePreviewDownload(workspace, "../escape.txt", Buffer.from("bad"))).rejects.toThrow("outside the workspace");
});

it("deletes only a named Preview profile", async () => {
  const { dir } = await fixture();
  const profile = join(dir, "browser-profiles", "tau-preview-demo");
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "cookies"), "synthetic");
  await clearHeadlessPreviewProfile(dir, "persist:tau-preview-demo");
  await expect(readFile(join(profile, "cookies"))).rejects.toThrow();
  await expect(clearHeadlessPreviewProfile(dir, "persist:tau-preview")).rejects.toThrow("default profile");
  await expect(clearHeadlessPreviewProfile(dir, "../../outside")).rejects.toThrow("Not a Preview profile");
});
