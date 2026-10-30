import { mkdir, mkdtemp, realpath, rename, rm, symlink, truncate, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FILE_DOWNLOAD_MAX_BYTES } from "./protocol.js";
import { downloadName, prepareFileDownload } from "./workspace-download.js";

vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, homedir: vi.fn(os.homedir) };
});
const roots: string[] = [];
afterEach(async () => { vi.mocked(homedir).mockReset(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "tau-file-download-")));
  roots.push(home); vi.mocked(homedir).mockReturnValue(home);
  const project = join(home, "project"); await mkdir(project);
  return { home, project };
}
const request = (signal?: AbortSignal, method = "GET") => new Request("http://resource.invalid/download", { signal, method });

describe("workspace file download capability", () => {
  it("keeps the original bytes inert and encodes a hostile filename without header injection", async () => {
    const { project } = await fixture();
    const name = 'résumé\r\nX-Evil: yes.docx'; const bytes = Buffer.from([0, 255, 60, 62]);
    await writeFile(join(project, name), bytes);
    const download = await prepareFileDownload(project, name, false);
    expect(download).toMatchObject({ size: bytes.length, name: "résumé__X-Evil_ yes.docx" });
    const head = await download.respond(request(undefined, "HEAD"));
    expect(head.body).toBeNull();
    expect(head.headers.get("content-type")).toBe("application/octet-stream");
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
    const disposition = head.headers.get("content-disposition")!;
    expect(disposition).toContain("attachment; filename=");
    expect(disposition).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9");
    expect(disposition).not.toMatch(/[\r\n]/u);
    expect(Buffer.from(await (await download.respond(request())).arrayBuffer())).toEqual(bytes);
    expect(downloadName('/docs/quote"\\..\u202e')).not.toMatch(/[\p{C}"/\\]/u);
  });
  it("refuses traversal, outside absolute paths, directories, and escaping symlinks for Full access too", async () => {
    const { project, home } = await fixture(); await writeFile(join(home, "outside"), "secret");
    await symlink(join(home, "outside"), join(project, "escape.docx"));
    for (const full of [false, true]) for (const path of ["../outside", join(home, "outside"), "escape.docx", "."]) {
      await expect(prepareFileDownload(project, path, full)).rejects.toThrow(/workspace|regular file/u);
    }
  });
  it("rechecks Read-only canonical hidden-Home and Git boundaries", async () => {
    const { project, home } = await fixture();
    await mkdir(join(home, ".secret")); await writeFile(join(home, ".secret", "report.docx"), "secret");
    await mkdir(join(project, ".git")); await writeFile(join(project, ".git", "report.docx"), "git secret");
    await mkdir(join(project, ".github")); await writeFile(join(project, ".github", "report.docx"), "project dotfile");
    await symlink(join(home, ".secret", "report.docx"), join(home, "public.docx"));
    for (const path of [".secret/report.docx", "public.docx", "project/.git/report.docx"]) {
      await expect(prepareFileDownload(home, path, false)).rejects.toThrow(/readable workspace/u);
    }
    expect(await (await (await prepareFileDownload(project, ".github/report.docx", false)).respond(request())).text()).toBe("project dotfile");
    expect(await (await (await prepareFileDownload(home, "public.docx", true)).respond(request())).text()).toBe("secret");
  });
  it("rejects symlink replacement after publication, including an inside-workspace replacement", async () => {
    const { project, home } = await fixture();
    await writeFile(join(project, "a.docx"), "original"); await writeFile(join(home, "secret"), "secret");
    const download = await prepareFileDownload(project, "a.docx", false);
    await rename(join(project, "a.docx"), join(project, "old.docx"));
    await symlink(join(home, "secret"), join(project, "a.docx"));
    await expect(download.respond(request())).rejects.toThrow(/workspace/u);
    await unlink(join(project, "a.docx"));
    await writeFile(join(project, "a.docx"), "original");
    await expect(download.respond(request())).rejects.toThrow(/changed/u);
  });
  it("rejects a file above the existing transport limit before reading it and detects later growth", async () => {
    const { project } = await fixture(); const path = join(project, "large.zip");
    await writeFile(path, ""); await truncate(path, FILE_DOWNLOAD_MAX_BYTES + 1);
    await expect(prepareFileDownload(project, "large.zip", false)).rejects.toThrow("10 MiB");
    await truncate(path, 1);
    const download = await prepareFileDownload(project, "large.zip", false);
    await truncate(path, 2);
    await expect(download.respond(request())).rejects.toThrow(/changed/u);
  });
  it("does not continue after abort and cancels an unfinished body", async () => {
    const { project } = await fixture(); await writeFile(join(project, "a.zip"), Buffer.alloc(256 * 1024));
    const download = await prepareFileDownload(project, "a.zip", false);
    const controller = new AbortController(); controller.abort();
    await expect(download.respond(request(controller.signal))).rejects.toThrow();
    const response = await download.respond(request());
    const reader = response.body!.getReader(); await reader.read();
    await reader.cancel();
    expect(await reader.read()).toMatchObject({ done: true });
    // Cancellation closed its handle; the same capability may be read afresh.
    expect((await (await download.respond(request())).arrayBuffer()).byteLength).toBe(256 * 1024);
  });
});
