import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
    await built(tau);
    await writeWorkbenchSourceRoot(userData, tau);
    await expect(readWorkbenchSourceRoot(userData)).resolves.toBe(tau);
    await rm(join(tau, "dist-electron/preload/bundle.cjs"));
    await expect(readWorkbenchSourceRoot(userData)).resolves.toBeUndefined();
  });
});

it("refuses changed compiled code until the user selects the build again", async () => {
  const tau = await fixture();
  await built(tau);
  const userData = await fixture();
  await writeWorkbenchSourceRoot(userData, tau);
  await expect(readWorkbenchSourceRoot(userData)).resolves.toBe(tau);
  await writeFile(join(tau, "dist-electron/main/other.js"), "changed imported module");
  await expect(readWorkbenchSourceRoot(userData)).resolves.toBeUndefined();
  await writeWorkbenchSourceRoot(userData, tau);
  await expect(readWorkbenchSourceRoot(userData)).resolves.toBe(tau);
  await writeFile(join(tau, "dist-electron/main/index.js"), "changed entry point");
  await expect(readWorkbenchSourceRoot(userData)).resolves.toBeUndefined();
});

it("does not load a legacy source pointer that has no build digest", async () => {
  const tau = await fixture();
  const userData = await fixture();
  await built(tau);
  await writeFile(join(userData, "workbench-source.json"), JSON.stringify({ version: 1, root: tau }));
  await expect(readWorkbenchSourceRoot(userData)).resolves.toBeUndefined();
});

it.skipIf(process.platform === "win32")("rejects a symlink replacing a pinned build file even if its bytes are unchanged", async () => {
  const tau = await fixture();
  const userData = await fixture();
  await built(tau);
  await writeWorkbenchSourceRoot(userData, tau);
  const file = join(tau, "dist-electron/main/index.js");
  const replacement = join(userData, "index.js");
  await writeFile(replacement, "");
  await rm(file);
  await symlink(replacement, file);
  await expect(readWorkbenchSourceRoot(userData)).resolves.toBeUndefined();
  await expect(writeWorkbenchSourceRoot(userData, tau)).rejects.toThrow(/symbolic links/u);
});
