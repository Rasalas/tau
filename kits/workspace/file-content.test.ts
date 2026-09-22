import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { languageForFile, MAX_FILE_CONTENT_BYTES, readBoundedFileContent, statFile, writeTextFile } from "./file-content.js";

const directories: string[] = [];

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
