import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PackageBuildJournal, buildDiagnostics, describeBuildError } from "./package-builds.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function failedBuild(source: string): Promise<{ error: unknown; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "tau-build-"));
  dirs.push(dir);
  await writeFile(join(dir, "desktop.tsx"), source);
  try {
    await build({ entryPoints: [join(dir, "desktop.tsx")], bundle: true, write: false, logLevel: "silent" });
  } catch (error) {
    return { error, dir };
  }
  throw new Error("the build did not fail");
}

describe("package builds", () => {
  it("turns esbuild's errors into file, line, column and text, relative to the package", async () => {
    const { error, dir } = await failedBuild("const x y = 1;\nexport default x;\n");
    expect(buildDiagnostics(error, dir)).toEqual([{ file: "desktop.tsx", line: 1, column: 8, text: "Expected \";\" but found \"y\"", lineText: "const x y = 1;" }]);
    const described = describeBuildError(error, dir);
    // The whole error, not esbuild's "Build failed with 1 error:" headline.
    expect(described.message).toBe("desktop.tsx:1:8: Expected \";\" but found \"y\"\n  const x y = 1;\n          ^");
  });

  it("keeps the message of an error that is not esbuild's", () => {
    expect(describeBuildError(new Error("entry is gone"))).toEqual({ message: "entry is gone" });
  });

  it("keeps the last build per half and entry, newest first, and tells its observers", () => {
    const journal = new PackageBuildJournal();
    const seen = vi.fn();
    const stop = journal.observe(seen);
    journal.record({ id: "me.kit", directory: "/k", half: "desktop", entry: "/k/desktop.tsx", at: 1, ok: false, message: "boom" });
    journal.record({ id: "me.kit", directory: "/k", half: "host", entry: "/k/host.ts", at: 2, ok: true });
    journal.record({ id: "me.kit", directory: "/k", half: "desktop", entry: "/k/desktop.tsx", at: 3, ok: true });
    expect(journal.list().map((entry) => [entry.half, entry.at, entry.ok])).toEqual([["desktop", 3, true], ["host", 2, true]]);
    stop();
    journal.record({ directory: "/k", half: "host", entry: "/k/host.ts", at: 4, ok: true });
    expect(seen).toHaveBeenCalledTimes(3);
  });
});
