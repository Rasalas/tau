import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractZipEntry, isPlainFileEntry, readZipDirectory } from "./zip.js";
import { buildZip } from "./zip-fixture.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-zip-"));
  directories.push(directory);
  return directory;
}

describe("zip loader", () => {
  it("reads the directory and extracts stored and deflated members with their exact sizes", async () => {
    const directory = await scratch();
    const big = Buffer.alloc(300_000, "a");
    const archive = join(directory, "a.zip");
    await writeFile(archive, buildZip([{ name: "server.par", data: big }, { name: "harness", data: Buffer.from("harness!"), method: 0 }]));
    const entries = await readZipDirectory(archive);
    expect(entries.map((entry) => [entry.name, entry.compressionMethod, entry.uncompressedSize])).toEqual([["server.par", 8, 300_000], ["harness", 0, 8]]);
    expect(entries.every(isPlainFileEntry)).toBe(true);
    await extractZipEntry(archive, entries[0]!, join(directory, "server.par"), 300_000);
    await extractZipEntry(archive, entries[1]!, join(directory, "harness"), 8);
    expect((await readFile(join(directory, "server.par"))).equals(big)).toBe(true);
    expect((await readFile(join(directory, "harness"))).toString()).toBe("harness!");
  });

  it("refuses a member whose size does not match, and marks directories and encrypted members as unsafe", async () => {
    const directory = await scratch();
    const archive = join(directory, "b.zip");
    await writeFile(archive, buildZip([
      { name: "server.par", data: Buffer.from("hello world") },
      { name: "sub/", data: Buffer.alloc(0), directory: true, method: 0 },
      { name: "secret", data: Buffer.from("x"), encrypted: true, method: 0 },
    ]));
    const entries = await readZipDirectory(archive);
    expect(entries.map(isPlainFileEntry)).toEqual([true, false, false]);
    await expect(extractZipEntry(archive, entries[0]!, join(directory, "short"), 5)).rejects.toThrow(/larger than its release record/u);
    await expect(extractZipEntry(archive, entries[0]!, join(directory, "long"), 20)).rejects.toThrow(/is 11 bytes, not the 20/u);
  });
});
