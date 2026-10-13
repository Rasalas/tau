import { chmod, lstat, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { languageForFile, MAX_FILE_CONTENT_BYTES, readBoundedFileContent, statFile, writeTextFile } from "./file-content.js";

const directories: string[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>();
  return { ...filesystem, rename: vi.fn(filesystem.rename) };
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-file-content-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("readBoundedFileContent", () => {
  it("returns source text with a language derived from the file name", async () => {
    const root = await workspace();
    const path = join(root, "index.ts");
    await writeFile(path, "export const answer = 42;\n");

    const content = await readBoundedFileContent(path);

    expect(content).toMatchObject({ kind: "text", name: "index.ts", language: "typescript", text: "export const answer = 42;\n" });
    expect(content.truncated).toBeUndefined();
  });

  it("flags binary files instead of decoding them", async () => {
    const root = await workspace();
    const path = join(root, "blob.bin");
    await writeFile(path, Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]));

    expect(await readBoundedFileContent(path)).toMatchObject({ kind: "binary", size: 6 });
  });

  it.each([Buffer.from("Grüße\n", "latin1"), Buffer.from([0xc3]), Buffer.concat([Buffer.alloc(9_000, 0x61), Buffer.from([0xff])])])(
    "does not offer invalid UTF-8 as editable text",
    async (bytes) => {
      const path = join(await workspace(), "legacy.txt");
      await writeFile(path, bytes);
      expect(await readBoundedFileContent(path)).toMatchObject({ kind: "binary" });
      await expect(readFile(path)).resolves.toEqual(bytes);
    },
  );

  it("finds binary bytes beyond the initial 8 KiB", async () => {
    const path = join(await workspace(), "blob.txt");
    await writeFile(path, Buffer.concat([Buffer.alloc(9_000, 0x61), Buffer.from([0])]));
    expect(await readBoundedFileContent(path)).toMatchObject({ kind: "binary" });
  });

  it("preserves a UTF-8 BOM and literal replacement characters", async () => {
    const path = join(await workspace(), "unicode.txt");
    const text = "\ufeffGrüße\r\n�";
    await writeFile(path, text);
    expect(await readBoundedFileContent(path)).toMatchObject({ kind: "text", text });
  });

  it("drops only an incomplete UTF-8 sequence at the preview ceiling", async () => {
    const path = join(await workspace(), "big.txt");
    const prefix = "x".repeat(MAX_FILE_CONTENT_BYTES - 4) + "�";
    await writeFile(path, prefix + "ü");
    const content = await readBoundedFileContent(path);
    expect(content).toMatchObject({ kind: "text", truncated: true });
    expect(content.text?.length).toBe(prefix.length);
    expect(content.text?.slice(-2)).toBe("x�");
  });

  it("cuts oversized files at the ceiling and marks them truncated", async () => {
    const root = await workspace();
    const path = join(root, "big.log");
    await writeFile(path, "x".repeat(MAX_FILE_CONTENT_BYTES + 512));

    const content = await readBoundedFileContent(path);

    expect(content.truncated).toBe(true);
    expect(content.text).toHaveLength(MAX_FILE_CONTENT_BYTES);
    expect(content.size).toBe(MAX_FILE_CONTENT_BYTES + 512);
  });

  it("returns images as a data URL", async () => {
    const root = await workspace();
    const path = join(root, "pixel.png");
    await writeFile(path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

    const content = await readBoundedFileContent(path);

    expect(content.kind).toBe("image");
    expect(content.dataUrl?.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects directories", async () => {
    const root = await workspace();
    await expect(readBoundedFileContent(root)).rejects.toThrow("Not a file.");
  });
});

describe("languageForFile", () => {
  it("maps extensions and well-known names", () => {
    expect(languageForFile("App.tsx")).toBe("typescript");
    expect(languageForFile("styles.css")).toBe("css");
    expect(languageForFile("Dockerfile")).toBe("bash");
    expect(languageForFile("LICENSE")).toBeUndefined();
  });
});

describe("writeTextFile", () => {
  it("leaves the original intact and removes temporary files when replacement fails", async () => {
    const root = await workspace();
    const path = join(root, "notes.txt");
    await writeFile(path, "old\n");
    vi.mocked(rename).mockRejectedValueOnce(new Error("Replacement failed"));
    await expect(writeTextFile(path, "new\n", undefined)).rejects.toThrow("Replacement failed");
    await expect(readFile(path, "utf8")).resolves.toBe("old\n");
    expect(await readdir(root)).toEqual(["notes.txt"]);
  });

  it("creates a missing file when the editor expects none", async () => {
    const path = join(await workspace(), "new.txt");
    await expect(writeTextFile(path, "new\n", null)).resolves.toMatchObject({ status: "written", size: 4 });
    await expect(readFile(path, "utf8")).resolves.toBe("new\n");
  });

  it("refuses to replace a dangling symlink", async () => {
    const root = await workspace();
    const path = join(root, "link.txt");
    await symlink("missing.txt", path);
    await expect(writeTextFile(path, "new\n", null)).rejects.toThrow("dangling symbolic link");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it("atomically replaces the file and preserves its permissions and owner", async () => {
    const root = await workspace();
    const path = join(root, "script.sh");
    await writeFile(path, "old\n");
    await chmod(path, 0o751);
    const before = await stat(path);
    const reader = await open(path, "r");
    try {
      await expect(writeTextFile(path, "new\n", before.mtimeMs)).resolves.toMatchObject({ status: "written" });
      await expect(reader.readFile("utf8")).resolves.toBe("old\n");
      await expect(readFile(path, "utf8")).resolves.toBe("new\n");
      const after = await stat(path);
      expect(after.mode).toBe(before.mode);
      expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
      expect(await readdir(root)).toEqual(["script.sh"]);
    } finally {
      await reader.close();
    }
  });

  it("keeps a symlink and atomically replaces its target", async () => {
    const root = await workspace();
    const path = join(root, "target.txt");
    const link = join(root, "link.txt");
    await writeFile(path, "old\n");
    await symlink("target.txt", link);
    await writeTextFile(link, "new\n", (await stat(path)).mtimeMs);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(readFile(path, "utf8")).resolves.toBe("new\n");
  });

  it("writes when the file is as the editor last saw it and reports the new mtime", async () => {
    const root = await workspace();
    const path = join(root, "a.txt");
    await writeFile(path, "one\n");
    const read = await readBoundedFileContent(path);

    const result = await writeTextFile(path, "two\n", read.mtimeMs);

    expect(result).toMatchObject({ status: "written", size: 4 });
    await expect(readFile(path, "utf8")).resolves.toBe("two\n");
    expect((await statFile(path)).mtimeMs).toBe(result.status === "written" ? result.mtimeMs : -1);
  });

  it("refuses a write when the file changed on disk since it was read", async () => {
    const root = await workspace();
    const path = join(root, "a.txt");
    await writeFile(path, "one\n");
    const read = await readBoundedFileContent(path);
    await writeFile(path, "someone else\n");
    await utimes(path, new Date(), new Date(Date.now() + 5_000));

    const result = await writeTextFile(path, "mine\n", read.mtimeMs);

    expect(result.status).toBe("conflict");
    await expect(readFile(path, "utf8")).resolves.toBe("someone else\n");
    // Keeping one's own version means writing without the check.
    await expect(writeTextFile(path, "mine\n", undefined)).resolves.toMatchObject({ status: "written" });
    await expect(readFile(path, "utf8")).resolves.toBe("mine\n");
  });

  it("treats a file that appeared or vanished as a conflict too", async () => {
    const root = await workspace();
    const path = join(root, "new.txt");
    await writeFile(path, "there\n");
    await expect(writeTextFile(path, "x", null)).resolves.toMatchObject({ status: "conflict" });
    await expect(writeTextFile(join(root, "gone.txt"), "x", 123)).resolves.toEqual({ status: "conflict" });
    await expect(statFile(join(root, "gone.txt"))).resolves.toEqual({ exists: false });
  });
});
