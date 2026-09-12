import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkbenchSourceRoot, resolveTauSourceRoot, writeWorkbenchSourceRoot } from "./workbench-source.js";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "tau-workbench-source-"));
  const root = await realpath(created);
  roots.push(root);
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "src/main"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tau-pi-desktop-prototype" }));
  await writeFile(join(root, "scripts/build.mjs"), "");
  await writeFile(join(root, "src/main/index.ts"), "");
  return root;
}

async function built(root: string): Promise<void> {
  for (const relative of ["dist/index.html", "dist-electron/main/index.js", "dist-electron/preload/bundle.cjs", "dist-kits/manifest.json"]) {
    await mkdir(join(root, relative, ".."), { recursive: true });
    await writeFile(join(root, relative), relative.endsWith(".json") ? "{}" : "");
  }
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workbench source checkout", () => {
  it("accepts Tau source and rejects an ordinary project", async () => {
    const tau = await fixture();
    const ordinary = await realpath(await mkdtemp(join(tmpdir(), "ordinary-source-")));
    roots.push(ordinary);

    await expect(resolveTauSourceRoot(tau)).resolves.toBe(tau);
    await expect(resolveTauSourceRoot(ordinary)).resolves.toBeUndefined();
  });

  it("only restores a persisted checkout while all built artifacts remain", async () => {
    const tau = await fixture();
    const userData = await realpath(await mkdtemp(join(tmpdir(), "tau-user-data-")));
    roots.push(userData);
    await writeWorkbenchSourceRoot(userData, tau);

    await expect(readWorkbenchSourceRoot(userData)).resolves.toBeUndefined();
    await built(tau);
    await expect(readWorkbenchSourceRoot(userData)).resolves.toBe(tau);
  });
});
