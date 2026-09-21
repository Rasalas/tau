import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchBuildResult } from "../shared/contracts.js";
import { workbenchSourceStatePath } from "./workbench-source.js";
import { WorkbenchReloader } from "./workbench-reloader.js";

const roots: string[] = [];
const successfulBuild: WorkbenchBuildResult = { ok: true, durationMs: 12, mainChanged: false, runtimeChanged: false, output: "built" };

async function directory(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  const canonical = await realpath(root);
  roots.push(canonical);
  return canonical;
}

async function tauCheckout(): Promise<string> {
  const root = await directory("tau-source");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "src/main"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "tau-pi-desktop-prototype" }));
  await writeFile(join(root, "scripts/build.mjs"), "");
  await writeFile(join(root, "src/main/index.ts"), "");
  return root;
}

async function writeBuiltArtifacts(root: string): Promise<void> {
  for (const relative of ["dist/index.html", "dist-electron/main/index.js", "dist-electron/preload/bundle.cjs", "dist-kits/manifest.json"]) {
    await mkdir(join(root, relative, ".."), { recursive: true });
    await writeFile(join(root, relative), relative.endsWith(".json") ? "{}" : "");
  }
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkbenchReloader", () => {
  it("rebuilds an unpackaged workbench from its app path", async () => {
    const rebuild = vi.fn(async () => successfulBuild);
    const app = { relaunch: vi.fn(), quit: vi.fn() };
    const reloader = new WorkbenchReloader({ packaged: false, appPath: "/checkout", userData: "/data", rebuild, app });

    await expect(reloader.rebuild("/another-project")).resolves.toEqual(successfulBuild);
    expect(rebuild).toHaveBeenCalledWith("/checkout", expect.any(Object));

    reloader.relaunch();
    expect(app.relaunch).toHaveBeenCalledWith();
    expect(app.quit).toHaveBeenCalled();
  });

  it("only reloads extensions when a packaged app is not open on Tau source", async () => {
    const project = await directory("ordinary-project");
    const userData = await directory("user-data");
    const rebuild = vi.fn(async () => successfulBuild);
    const app = { relaunch: vi.fn(), quit: vi.fn() };
    const reloader = new WorkbenchReloader({ packaged: true, appPath: "/installed/app.asar", userData, rebuild, app });

    await expect(reloader.rebuild(project)).resolves.toMatchObject({ ok: true, mainChanged: false });
    expect(rebuild).not.toHaveBeenCalled();
  });

  it("builds an open Tau checkout, persists it, and forces a packaged relaunch", async () => {
    const source = await tauCheckout();
    const userData = await directory("user-data");
    const rebuild = vi.fn(async () => { await writeBuiltArtifacts(source); return successfulBuild; });
    const app = { relaunch: vi.fn(), quit: vi.fn() };
    const reloader = new WorkbenchReloader({ packaged: true, appPath: "/installed/app.asar", userData, rebuild, app });

    await expect(reloader.rebuild(source)).resolves.toEqual({ ...successfulBuild, mainChanged: true });
    expect(rebuild).toHaveBeenCalledWith(source, expect.any(Object));
    expect(JSON.parse(await readFile(workbenchSourceStatePath(userData), "utf8"))).toEqual({ version: 1, root: source });

    reloader.relaunch();
    expect(app.relaunch).toHaveBeenCalledWith();
    expect(app.quit).toHaveBeenCalled();
  });

  it("uses the managed source when the installed app is open on another project", async () => {
    const source = await tauCheckout();
    const project = await directory("ordinary-project");
    const userData = await directory("user-data");
    const rebuild = vi.fn(async () => { await writeBuiltArtifacts(source); return successfulBuild; });
    const managedSource = { existing: vi.fn(async () => source), ensure: vi.fn(async () => source) };
    const reloader = new WorkbenchReloader({
      packaged: true,
      appPath: "/installed/app.asar",
      userData,
      managedSource,
      rebuild,
      app: { relaunch: vi.fn(), quit: vi.fn() },
    });

    await expect(reloader.rebuild(project)).resolves.toMatchObject({ ok: true, mainChanged: true });
    expect(rebuild).toHaveBeenCalledWith(source, expect.any(Object));
    expect(managedSource.ensure).not.toHaveBeenCalled();
  });

  it("does not persist a checkout whose build omitted required artifacts", async () => {
    const source = await tauCheckout();
    const userData = await directory("user-data");
    const rebuild = vi.fn(async () => successfulBuild);
    const reloader = new WorkbenchReloader({
      packaged: true,
      appPath: "/installed/app.asar",
      userData,
      rebuild,
      app: { relaunch: vi.fn(), quit: vi.fn() },
    });

    const result = await reloader.rebuild(source);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("required build output");
  });
});
