import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRange, SharedFileStore } from "./shared-files.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-shared-"));
  outside = await mkdtemp(join(tmpdir(), "tau-outside-"));
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs", "paper.pdf"), "%PDF-1.4 0123456789");
  await writeFile(join(root, "notes.txt"), "plain");
  await writeFile(join(outside, "secret.pdf"), "%PDF secret");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("SharedFileStore", () => {
  it("serves a workspace PDF under a token, whole or by range", async () => {
    const store = new SharedFileStore(() => root);
    const shared = await store.share(join(root, "docs", "paper.pdf"));
    expect(shared).toMatchObject({ name: "paper.pdf", size: 19, mimeType: "application/pdf" });
    expect(shared.url).toMatch(/^tau-ext:\/\/files\/[0-9a-f]{32}\/paper\.pdf$/u);

    const whole = await store.respond(shared.url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Content-Type")).toBe("application/pdf");
    expect(whole.headers.get("Accept-Ranges")).toBe("bytes");
    await expect(whole.text()).resolves.toBe("%PDF-1.4 0123456789");

    const part = await store.respond(shared.url, "bytes=9-12");
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe("bytes 9-12/19");
    await expect(part.text()).resolves.toBe("0123");
  });

  it("refuses a file outside the workspace, through a symlink too", async () => {
    const store = new SharedFileStore(() => root);
    await expect(store.share(join(outside, "secret.pdf"))).rejects.toThrow(/outside the workspace/u);
    await symlink(join(outside, "secret.pdf"), join(root, "link.pdf"));
    await expect(store.share(join(root, "link.pdf"))).rejects.toThrow(/outside the workspace/u);
    await expect(store.share(join(root, "docs", "..", "..", "x.pdf"))).rejects.toThrow();
  });

  it("shares only types a browser draws itself, and nothing before a workspace is open", async () => {
    await expect(new SharedFileStore(() => root).share(join(root, "notes.txt"))).rejects.toThrow(/PDFs, images, audio and video/u);
    await expect(new SharedFileStore(() => undefined).share(join(root, "docs", "paper.pdf"))).rejects.toThrow(/No workspace/u);
  });

  it("answers 404 for an unknown token and after a clear", async () => {
    const store = new SharedFileStore(() => root);
    const shared = await store.share(join(root, "docs", "paper.pdf"));
    expect((await store.respond("tau-ext://files/00000000000000000000000000000000/x.pdf")).status).toBe(404);
    expect((await store.respond("tau-ext://bundles/whatever")).status).toBe(404);
    expect((await store.respond("not a url")).status).toBe(404);
    store.clear();
    expect((await store.respond(shared.url)).status).toBe(404);
  });

  it("gives the same file the same token", async () => {
    const store = new SharedFileStore(() => root);
    const first = await store.share(join(root, "docs", "paper.pdf"));
    const second = await store.share(join(root, "docs", "paper.pdf"));
    expect(second.url).toBe(first.url);
  });
});

describe("parseRange", () => {
  it("reads the byte ranges a media element sends", () => {
    expect(parseRange(undefined, 10)).toBeUndefined();
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange("bytes=5-99", 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=10-", 10)).toBe("invalid");
    expect(parseRange("bytes=4-2", 10)).toBe("invalid");
    expect(parseRange("items=0-1", 10)).toBeUndefined();
  });
});
