import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createPackagesHostExtension } from "./host.js";
import { CUSTOMIZATION_PROJECT_NAME, PACKAGES_EXTENSION_ID, type CustomizationFolder, type CustomizationProject } from "./protocol.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "tau-customize-project-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".tau", "extensions");
  const admitWorkspace = vi.fn((path: string) => ({ workspaceId: `ws1_${path.length}`, displayPath: path }));
  const rememberProjectName = vi.fn();
  const registry = await activateHostKit(createPackagesHostExtension(), { globalExtensionsDirectory: () => directory, admitWorkspace, rememberProjectName } as never);
  const call = <T>(command: string) => registry.invoke(PACKAGES_EXTENSION_ID, command) as Promise<T>;
  return { directory, admitWorkspace, rememberProjectName, call };
}

describe("the customization project", () => {
  it("is the global extension folder, made on the first call, admitted under one name", async () => {
    const { directory, admitWorkspace, rememberProjectName, call } = await setup();
    await expect(stat(directory)).rejects.toThrow();
    // Asking for the folder creates nothing.
    expect(await call<CustomizationFolder>("customization-folder")).toEqual({ directory, packages: 0 });
    await expect(stat(directory)).rejects.toThrow();

    const project = await call<CustomizationProject>("customization-project");
    const path = await realpath(directory);
    expect(project).toEqual({ directory: path, workspaceId: `ws1_${path.length}` });
    expect(admitWorkspace).toHaveBeenCalledWith(path);
    expect(rememberProjectName).toHaveBeenCalledWith(path, CUSTOMIZATION_PROJECT_NAME);
  });

  it("is the same project on the second call, and keeps what the folder holds", async () => {
    const { directory, admitWorkspace, call } = await setup();
    const first = await call<CustomizationProject>("customization-project");
    await mkdir(join(directory, "copy-branch"));
    await writeFile(join(directory, "copy-branch", "tau-extension.json"), "{}");
    await mkdir(join(directory, ".tau"));
    await mkdir(join(directory, "notes"));
    const second = await call<CustomizationProject>("customization-project");
    expect(second).toEqual(first);
    expect(new Set(admitWorkspace.mock.calls.map(([path]) => path)).size).toBe(1);
    expect((await stat(join(directory, "copy-branch", "tau-extension.json"))).isFile()).toBe(true);
    expect(await call<CustomizationFolder>("customization-folder")).toEqual({ directory: first.directory, packages: 1 });
  });

  it("names the folder again after a start, before anyone asks", async () => {
    const { directory, rememberProjectName } = await setup();
    await vi.waitFor(() => expect(rememberProjectName).toHaveBeenCalledWith(directory, CUSTOMIZATION_PROJECT_NAME));
  });
});
