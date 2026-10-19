import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExtensionGrants } from "./extension-grants.js";
import { approvePackageFolder, reviewPackageFolder } from "./package-approval.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-approval-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function setup() {
  const home = await scratch();
  const root = join(home, ".tau", "extensions");
  await mkdir(root, { recursive: true });
  const grantsFilePath = join(await scratch(), "grants.json");
  const options = { cwd: "/nowhere", agentDir: "/agent", home, grantsFilePath };
  const write = async (name: string, files: Record<string, string>, manifest: object = { id: `acme.${name}`, name: "Hello", description: "Says hello", permissions: ["sessions"], desktop: "./desktop.tsx", host: "./host.ts" }) => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "tau-extension.json"), JSON.stringify(manifest));
    for (const [file, source] of Object.entries(files)) await writeFile(join(dir, file), source);
    return dir;
  };
  return { home, root, options, write };
}

const GOOD = {
  "host.ts": "export default { id: 'acme.hello', name: 'Hello', activate() {} };\n",
  "desktop.tsx": "import { Package } from 'lucide-react';\nexport default { id: 'acme.hello', name: 'Hello', activate() { return Package; } };\n",
};

describe("reviewPackageFolder", () => {
  it("reads a package folder by name and by path, and grants nothing", async () => {
    const { options, write } = await setup();
    const dir = await write("hello", GOOD);
    const byName = await reviewPackageFolder("hello", options);
    expect(byName).toMatchObject({ id: "acme.hello", name: "Hello", description: "Says hello", directory: dir, permissions: ["sessions"], isolation: "worker", desktop: true, host: true, granted: false, buildErrors: [] });
    expect(await reviewPackageFolder(dir, options)).toEqual(byName);
    expect((await readExtensionGrants(options.grantsFilePath)).grants).toEqual([]);
  });

  it("refuses folders outside the global extension folder", async () => {
    const { options, write, home } = await setup();
    await write("hello", GOOD);
    const elsewhere = await scratch();
    await writeFile(join(elsewhere, "tau-extension.json"), "{}");
    for (const path of [elsewhere, "..", "../..", "", "   ", join(home, ".tau")]) {
      await expect(reviewPackageFolder(path, options)).rejects.toThrow(/directly inside|does not exist/u);
    }
    await expect(reviewPackageFolder(elsewhere, options)).rejects.toThrow("tau_new_package");
  });

  it("refuses a nested folder and a link that leaves the extension folder", async () => {
    const { options, root, write } = await setup();
    await write("hello", GOOD);
    await mkdir(join(root, "hello", "inner"));
    await expect(reviewPackageFolder("hello/inner", options)).rejects.toThrow("directly inside");
    const outside = await scratch();
    await writeFile(join(outside, "tau-extension.json"), JSON.stringify({ id: "acme.out", name: "Out", host: "./host.ts" }));
    await symlink(outside, join(root, "linked"));
    await expect(reviewPackageFolder("linked", options)).rejects.toThrow("directly inside");
  });

  it("names a missing or broken manifest", async () => {
    const { options, root, write } = await setup();
    await mkdir(join(root, "empty"));
    await expect(reviewPackageFolder("empty", options)).rejects.toThrow("has no tau-extension.json");
    await write("broken", {}, { id: "Bad Id", name: "x", host: "./host.ts" });
    await expect(reviewPackageFolder("broken", options)).rejects.toThrow('"id"');
  });

  it("returns build errors with file, line and column and does not trust the folder", async () => {
    const { options, write } = await setup();
    await write("hello", { "host.ts": "export default {;\n", "desktop.tsx": "import x from './missing';\nexport default x;\n" });
    const review = await reviewPackageFolder("hello", options);
    expect(review.buildErrors).toHaveLength(2);
    const [host, desktop] = review.buildErrors;
    expect(host!.diagnostics![0]).toMatchObject({ file: "host.ts", line: 1 });
    expect(desktop!.diagnostics![0]).toMatchObject({ file: "desktop.tsx", line: 1 });
  });

  it("accepts the workbench's shared modules in the window half", async () => {
    const { options, write } = await setup();
    await write("hello", { ...GOOD, "desktop.tsx": "import { permissionTitle } from 'tau';\nimport { jsx } from 'react/jsx-runtime';\nexport default { id: 'x', name: 'x', activate() { return [permissionTitle, jsx]; } };\n" });
    expect((await reviewPackageFolder("hello", options)).buildErrors).toEqual([]);
  });

  it("changes its fingerprint when a file or the permissions change", async () => {
    const { options, write } = await setup();
    await write("hello", GOOD);
    const first = (await reviewPackageFolder("hello", options)).fingerprint;
    expect((await reviewPackageFolder("hello", options)).fingerprint).toBe(first);
    await write("hello", { ...GOOD, "host.ts": `${GOOD["host.ts"]}// edit\n` });
    expect((await reviewPackageFolder("hello", options)).fingerprint).not.toBe(first);
  });
});

describe("approvePackageFolder", () => {
  it("grants exactly what the user saw for the owner, with no native dialog", async () => {
    const { options, write } = await setup();
    await write("hello", GOOD);
    const { fingerprint } = await reviewPackageFolder("hello", options);
    expect(await approvePackageFolder("hello", fingerprint, { ...options, owner: true })).toBe("acme.hello");
    const { grants } = await readExtensionGrants(options.grantsFilePath);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ id: "acme.hello", permissions: ["sessions"], isolation: "worker" });
    expect((await reviewPackageFolder("hello", options)).granted).toBe(true);
  });

  it("grants nothing for a connection that is not the owner", async () => {
    const { options, write } = await setup();
    await write("hello", GOOD);
    const { fingerprint } = await reviewPackageFolder("hello", options);
    await expect(approvePackageFolder("hello", fingerprint, { ...options, owner: false })).rejects.toThrow("owner");
    expect((await readExtensionGrants(options.grantsFilePath)).grants).toEqual([]);
  });

  it("refuses a folder that changed after the card", async () => {
    const { options, write } = await setup();
    await write("hello", GOOD);
    const { fingerprint } = await reviewPackageFolder("hello", options);
    await write("hello", { ...GOOD, "host.ts": `${GOOD["host.ts"]}// sneaky\n` });
    await expect(approvePackageFolder("hello", fingerprint, { ...options, owner: true })).rejects.toThrow("changed after");
    expect((await readExtensionGrants(options.grantsFilePath)).grants).toEqual([]);
  });
});
