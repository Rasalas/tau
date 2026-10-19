import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renameReplacing } from "./atomic-rename.js";

const mocks = vi.hoisted(() => ({ rename: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  mocks.rename.mockImplementation(actual.rename);
  return { ...actual, rename: mocks.rename };
});

const directories: string[] = [];
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  mocks.rename.mockReset().mockImplementation(actual.rename);
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const locked = (code: string) => Object.assign(new Error(code), { code });
async function pair() {
  const directory = await mkdtemp(join(tmpdir(), "tau-kit-atomic-rename-"));
  directories.push(directory);
  const from = join(directory, "from"), to = join(directory, "to");
  await writeFile(from, "new");
  await writeFile(to, "old");
  return { from, to };
}

describe("renameReplacing", () => {
  it.each(["EPERM", "EBUSY", "EACCES"])("retries a %s on Windows until the file is free", async (code) => {
    const { from, to } = await pair();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    mocks.rename.mockRejectedValueOnce(locked(code)).mockRejectedValueOnce(locked(code)).mockImplementation(actual.rename);
    await renameReplacing(from, to, { platform: "win32", delaysMs: [0, 0, 0] });
    expect(mocks.rename).toHaveBeenCalledTimes(3);
    expect(await readFile(to, "utf8")).toBe("new");
  });

  it("gives up with the last error once the retries are spent", async () => {
    const { from, to } = await pair();
    const error = locked("EPERM");
    mocks.rename.mockRejectedValue(error);
    await expect(renameReplacing(from, to, { platform: "win32", delaysMs: [0, 0] })).rejects.toBe(error);
    expect(mocks.rename).toHaveBeenCalledTimes(3);
  });

  it("does not retry other errors or other platforms", async () => {
    const { from, to } = await pair();
    mocks.rename.mockRejectedValue(locked("ENOSPC"));
    await expect(renameReplacing(from, to, { platform: "win32", delaysMs: [0, 0] })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(mocks.rename).toHaveBeenCalledTimes(1);
    mocks.rename.mockClear().mockRejectedValue(locked("EPERM"));
    await expect(renameReplacing(from, to, { platform: "linux", delaysMs: [0, 0] })).rejects.toMatchObject({ code: "EPERM" });
    expect(mocks.rename).toHaveBeenCalledTimes(1);
  });
});
