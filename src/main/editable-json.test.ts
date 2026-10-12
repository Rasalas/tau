import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editJsonFiles, readJson, readJsonSync, writeJson } from "./editable-json.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, rename: vi.fn(original.rename) };
});

describe("editable JSON", () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "tau-editable-json-"));
    path = join(directory, "config.json");
  });

  afterEach(async () => {
    vi.mocked(rename).mockClear();
    await rm(directory, { recursive: true, force: true });
  });

  it("treats only a missing file as empty in both readers", async () => {
    expect(await readJson(path)).toBeUndefined();
    expect(readJsonSync(path)).toBeUndefined();
    await mkdir(path);
    await expect(readJson(path)).rejects.toThrow(path);
    expect(() => readJsonSync(path)).toThrow(path);
  });

  it.each(["null", "[]", "42", '{"key":true,}'])("rejects unusable JSON %s without changing the file", async (contents) => {
    await writeFile(path, contents);
    await expect(readJson(path)).rejects.toThrow(path);
    expect(() => readJsonSync(path)).toThrow(path);
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("keeps the original file when replacing it fails, then permits a later edit", async () => {
    const original = '{"keep":true}';
    await writeFile(path, original);
    vi.mocked(rename).mockRejectedValueOnce(new Error("rename failed"));
    await expect(editJsonFiles([path], () => writeJson(path, { next: true }))).rejects.toThrow("rename failed");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(directory)).toEqual(["config.json"]);
    await editJsonFiles([path], () => writeJson(path, { next: true }));
    expect(await readJson(path)).toEqual({ next: true });
  });

  it("holds overlapping file edits until the preceding edit finishes", async () => {
    const secondPath = join(directory, "auth.json");
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    const events: string[] = [];
    const first = editJsonFiles([path, secondPath], async () => {
      events.push("first started");
      enter();
      await release;
      events.push("first finished");
    });
    await entered;
    const second = editJsonFiles([join(directory, ".", "auth.json")], async () => { events.push("second"); });
    await editJsonFiles([join(directory, "other.json")], async () => { events.push("independent"); });
    expect(events).toEqual(["first started", "independent"]);
    finish();
    await Promise.all([first, second]);
    expect(events).toEqual(["first started", "independent", "first finished", "second"]);
  });
});
