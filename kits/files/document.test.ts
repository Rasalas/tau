import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiFileContent, UiFileStat, UiFileWriteResult } from "tau";
import { FileDocument, type DocumentPorts } from "./document.js";

/** A disk of one file whose mtime moves on every write, by the editor or by anybody else. */
class FakeDisk implements DocumentPorts {
  text: string | undefined;
  mtimeMs = 100;
  writes: Array<{ text: string; expected: number | null | undefined }> = [];
  failNextWrite = false;

  constructor(text: string | undefined, private readonly options: { truncated?: boolean; kind?: UiFileContent["kind"] } = {}) {
    this.text = text;
  }

  /** Somebody else writes the file: the agent, a formatter, another editor. */
  external(text: string | undefined): void {
    this.text = text;
    this.mtimeMs += 10;
  }

  read = async (relPath: string): Promise<UiFileContent> => {
    if (this.text === undefined) throw new Error("ENOENT: no such file");
    return {
      path: `/p/${relPath}`, name: relPath, size: this.text.length, mtimeMs: this.mtimeMs, kind: this.options.kind ?? "text",
      text: this.text, ...(this.options.truncated ? { truncated: true } : {}),
    };
  };

  stat = async (): Promise<UiFileStat> => this.text === undefined ? { exists: false } : { exists: true, size: this.text.length, mtimeMs: this.mtimeMs };

  write = async (_relPath: string, text: string, expected?: number | null): Promise<UiFileWriteResult> => {
    this.writes.push({ text, expected });
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error("EACCES: permission denied"); }
    const current = this.text === undefined ? null : this.mtimeMs;
    if (expected !== undefined && expected !== current) return this.text === undefined ? { status: "conflict" } : { status: "conflict", size: this.text.length, mtimeMs: this.mtimeMs };
    this.text = text;
    this.mtimeMs += 1;
    return { status: "written", size: text.length, mtimeMs: this.mtimeMs };
  };
}

async function opened(disk: FakeDisk, options?: ConstructorParameters<typeof FileDocument>[2]): Promise<FileDocument> {
  const document = new FileDocument("notes.md", disk, options);
  await document.load();
  return document;
}

afterEach(() => { vi.useRealTimers(); });

describe("FileDocument", () => {
  it("is dirty while the buffer differs from the disk and clean again after a save", async () => {
    const disk = new FakeDisk("one");
    const document = await opened(disk);
    const changes = vi.fn();
    document.subscribe(changes);
    expect(document.getState()).toMatchObject({ status: "ready", text: "one", dirty: false, editable: true });

    document.edit("two");
    expect(document.getState().dirty).toBe(true);
    document.edit("one");
    expect(document.getState().dirty).toBe(false);
    document.edit("two");

    await expect(document.save()).resolves.toBe(true);
    expect(document.getState()).toMatchObject({ dirty: false, saving: false, savedText: "two" });
    expect(disk.writes).toEqual([{ text: "two", expected: 100 }]);
    expect(changes).toHaveBeenCalled();
  });

  it("reloads a clean buffer when the file changes on disk", async () => {
    const disk = new FakeDisk("one");
    const document = await opened(disk);
    disk.external("from the agent");
    await document.check();
    expect(document.getState()).toMatchObject({ text: "from the agent", dirty: false });
    expect(document.getState().conflict).toBeUndefined();
  });

  it("does not take its own save for an external change", async () => {
    const disk = new FakeDisk("one");
    const document = await opened(disk);
    document.edit("two");
    await document.save();
    await document.check();
    expect(document.getState()).toMatchObject({ text: "two", dirty: false });
    expect(document.getState().conflict).toBeUndefined();
  });

  it("turns an external change under unsaved work into a conflict, and reload takes the disk's", async () => {
    const disk = new FakeDisk("one");
    const document = await opened(disk);
    document.edit("mine");
    disk.external("theirs");
    await document.check();
    expect(document.getState()).toMatchObject({ text: "mine", dirty: true, conflict: { deleted: false, mtimeMs: 110 } });
    // A save waits for the user's choice rather than writing over the disk.
    await expect(document.save()).resolves.toBe(false);
    expect(disk.writes).toEqual([]);

    await document.reload();
    expect(document.getState()).toMatchObject({ text: "theirs", dirty: false });
    expect(document.getState().conflict).toBeUndefined();
  });

  it("keeps this version on request and writes it over the disk's with the next save", async () => {
    const disk = new FakeDisk("one");
    const document = await opened(disk);
    document.edit("mine");
    disk.external("theirs");
    await document.check();

    document.keepMine();
    expect(document.getState()).toMatchObject({ dirty: true, text: "mine" });
    expect(document.getState().conflict).toBeUndefined();
    await expect(document.save()).resolves.toBe(true);
    expect(disk.text).toBe("mine");
    expect(disk.writes.at(-1)).toEqual({ text: "mine", expected: 110 });
  });

  it("keeps an unchanged buffer dirty after keeping it over a changed disk", async () => {
    const disk = new FakeDisk("one");
    const document = await opened(disk);
    document.edit("mine");
    disk.external("theirs");
    await document.check();
    document.keepMine();
    document.edit("one");
    // The disk holds "theirs" now, so even the old text is unsaved work.
    expect(document.getState().dirty).toBe(true);
  });

  it("reports a save the disk refused because it changed first", async () => {
    const disk = new FakeDisk("one");
    const document = await opened(disk);
    document.edit("mine");
    disk.external("theirs");
    await expect(document.save()).resolves.toBe(false);
    expect(document.getState()).toMatchObject({ dirty: true, conflict: { deleted: false } });
    expect(disk.text).toBe("theirs");
  });

  it("says when the file was deleted and recreates it when the user keeps the buffer", async () => {
    const disk = new FakeDisk("one");
    const document = await opened(disk);
    disk.external(undefined);
    await document.check();
    expect(document.getState().conflict).toEqual({ deleted: true });

    document.keepMine();
    await document.check();
    expect(document.getState().conflict).toBeUndefined();
    await expect(document.save()).resolves.toBe(true);
    expect(disk.writes.at(-1)).toEqual({ text: "one", expected: null });
    expect(disk.text).toBe("one");
  });

  it("keeps the buffer and says why when a write fails", async () => {
    const disk = new FakeDisk("one");
    const document = await opened(disk);
    document.edit("two");
    disk.failNextWrite = true;
    await expect(document.save()).resolves.toBe(false);
    expect(document.getState()).toMatchObject({ dirty: true, text: "two", saveError: "EACCES: permission denied" });
    await expect(document.save()).resolves.toBe(true);
  });

  it("only shows a file that was cut at the host's limit or is not text", async () => {
    const cut = await opened(new FakeDisk("partial", { truncated: true }));
    cut.edit("changed");
    expect(cut.getState()).toMatchObject({ editable: false, text: "partial", dirty: false });
    const binary = await opened(new FakeDisk("", { kind: "binary" }));
    expect(binary.getState().editable).toBe(false);
  });

  it("says what went wrong when the file cannot be read", async () => {
    const document = await opened(new FakeDisk(undefined));
    expect(document.getState()).toMatchObject({ status: "error", error: "ENOENT: no such file" });
  });

  it("saves on its own after a pause when autosave is on", async () => {
    vi.useFakeTimers();
    const disk = new FakeDisk("one");
    const document = await opened(disk, { autosaveMs: () => 1_000 });
    document.edit("t");
    document.edit("tw");
    document.edit("two");
    await vi.advanceTimersByTimeAsync(999);
    expect(disk.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(disk.writes).toEqual([{ text: "two", expected: 100 }]);
    expect(document.getState().dirty).toBe(false);
  });

  it("saves again when asked while a save is running", async () => {
    const disk = new FakeDisk("one");
    const document = await opened(disk);
    document.edit("two");
    const first = document.save();
    document.edit("three");
    const second = document.save();
    await expect(second).resolves.toBe(false);
    await expect(first).resolves.toBe(true);
    expect(disk.writes.map((write) => write.text)).toEqual(["two", "three"]);
    expect(document.getState()).toMatchObject({ dirty: false, savedText: "three" });
  });
});
