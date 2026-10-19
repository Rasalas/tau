import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOwnPackage, markOwnPackageOff, ownPackagesFilePath, recordOwnPackage } from "./own-packages.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-own-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function made(id = "local.mine") {
  const file = join(await scratch(), "own-packages.json");
  const directory = join(await scratch(), "mine");
  await mkdir(directory);
  await recordOwnPackage(file, { id, directory });
  return { file, directory, id };
}

describe("own packages", () => {
  it("sits next to the grants file", () => {
    expect(ownPackagesFilePath("/home/me/.tau/extension-grants.json")).toBe(join("/home/me/.tau", "own-packages.json"));
  });

  it("recognises the folder the scaffold wrote, and only under that id", async () => {
    const { file, directory, id } = await made();
    expect(await findOwnPackage(file, id, directory)).toMatchObject({ id });
    expect(await findOwnPackage(file, "local.other", directory)).toBeUndefined();
  });

  it("does not recognise another folder with the same id", async () => {
    const { file, id } = await made();
    const copy = join(await scratch(), "copy");
    await mkdir(copy);
    expect(await findOwnPackage(file, id, copy)).toBeUndefined();
  });

  it("does not take a statement from inside the package folder for provenance", async () => {
    const file = join(await scratch(), "own-packages.json");
    const directory = join(await scratch(), "forged");
    await mkdir(directory);
    await writeFile(join(directory, "tau-extension.json"), JSON.stringify({ id: "local.forged", name: "Forged", own: true }));
    await writeFile(join(directory, "own-packages.json"), JSON.stringify({ packages: [{ id: "local.forged", directory, createdAt: 1 }] }));
    expect(await findOwnPackage(file, "local.forged", directory)).toBeUndefined();
  });

  it("does not recognise a folder made again by hand under the same path", async () => {
    const { file, directory, id } = await made();
    const record = JSON.parse(await readFile(file, "utf8")) as { packages: Array<{ ino?: number }> };
    const ino = (await stat(directory)).ino;
    if (ino === 0) return;
    record.packages[0]!.ino = ino + 1;
    await writeFile(file, JSON.stringify(record));
    expect(await findOwnPackage(file, id, directory)).toBeUndefined();
  });

  it("remembers that the user turned it off, and that they turned it on", async () => {
    const { file, directory, id } = await made();
    await markOwnPackageOff(file, id, directory, true);
    expect((await findOwnPackage(file, id, directory))?.off).toBe(true);
    await markOwnPackageOff(file, id, directory, false);
    expect((await findOwnPackage(file, id, directory))?.off).toBe(false);
  });

  it("ignores an off mark for a package it never wrote", async () => {
    const { file } = await made();
    const foreign = join(await scratch(), "foreign");
    await mkdir(foreign);
    await markOwnPackageOff(file, "local.foreign", foreign, true);
    expect(await findOwnPackage(file, "local.foreign", foreign)).toBeUndefined();
  });

  it("keeps the other records when one more is written", async () => {
    const { file, directory, id } = await made();
    const second = join(await scratch(), "second");
    await mkdir(second);
    await recordOwnPackage(file, { id: "local.second", directory: second });
    expect(await findOwnPackage(file, id, directory)).toBeDefined();
    expect(await findOwnPackage(file, "local.second", second)).toBeDefined();
  });
});
