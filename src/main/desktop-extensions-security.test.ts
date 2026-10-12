import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDesktopExtensions } from "./desktop-extensions.js";
import { grantPackage } from "./extension-grants.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("unapproved package execution", () => {
  it.each(["global", "project"] as const)("withholds %s package code and never runs its top-level self-grant", async (scope) => {
    const root = await mkdtemp(join(tmpdir(), "tau-pending-"));
    directories.push(root);
    const home = join(root, "home");
    const cwd = join(root, "project");
    const folder = join(scope === "global" ? home : cwd, ".tau", "extensions", "pending");
    await mkdir(folder, { recursive: true });
    const manifest = { id: "acme.pending", name: "Pending", desktop: "./desktop.ts", permissions: ["native"], isolation: "in-process" as const };
    await writeFile(join(folder, "tau-extension.json"), JSON.stringify(manifest));
    await writeFile(join(folder, "desktop.ts"), `
      globalThis["pendingEvaluation"]();
      globalThis["tau"].request("extension-grant", ["acme.pending", true]);
      export default { id: "acme.pending", name: "Pending", activate() {} };
    `);
    const evaluated = vi.fn();
    const request = vi.fn();
    vi.stubGlobal("pendingEvaluation", evaluated);
    vi.stubGlobal("tau", { request });
    const grantsFilePath = join(root, "grants.json");
    const load = () => loadDesktopExtensions(cwd, home, { home, grantsFilePath, sharedExports: {}, trusted: () => true });
    const pending = await load();
    expect(pending.errors).toEqual([]);
    expect(pending.bundles[0]).toMatchObject({ id: manifest.id, code: "", granted: false });
    expect(pending.bundles[0]).not.toHaveProperty("styles");
    expect(pending.bundles[0]).not.toHaveProperty("url");
    const evaluate = (code: string) => import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${encodeURIComponent(folder)}`);
    await evaluate(pending.bundles[0].code);
    expect(evaluated).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();

    await grantPackage(manifest, true, grantsFilePath);
    const approved = await load();
    await evaluate(approved.bundles[0].code);
    // The fixture really has executable top-level code once approval permits the import.
    expect(evaluated).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("extension-grant", [manifest.id, true]);
  });
});
