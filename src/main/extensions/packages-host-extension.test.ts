import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalHostEvent } from "../../shared/contracts.js";
import { HostExtensionRegistry, type HostExtensionServices } from "../host-extensions.js";
import { PACKAGES_HOST_EXTENSION_ID, createPackagesHostExtension, describeInstalled } from "./packages-host-extension.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-pkgext-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

async function packageFolder(root: string): Promise<string> {
  const dir = join(root, "hello");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "tau-extension.json"), JSON.stringify({ id: "acme.hello", name: "Hello", version: "1.0.0", host: "./host.ts" }));
  await writeFile(join(dir, "host.ts"), "export default { activate() {} }");
  return dir;
}

function harness(cwd: string) {
  const events: GlobalHostEvent[] = [];
  const refreshExtensionPackages = vi.fn(async () => undefined);
  const services = {
    cwd: () => cwd,
    safeMode: false,
    log: vi.fn(),
    noteSubprocess: vi.fn(),
    findCommand: () => undefined,
    refreshExtensionPackages,
  } as unknown as HostExtensionServices;
  const registry = new HostExtensionRegistry(services, (event) => events.push(event));
  return { events, registry, refreshExtensionPackages };
}

describe("packages host extension", () => {
  it("registers install, remove, update and list, with the long ones as jobs", async () => {
    const { registry } = harness(await scratch());
    expect(await registry.activate(createPackagesHostExtension())).toBe(true);
    const summary = registry.summaries().find((entry) => entry.id === PACKAGES_HOST_EXTENSION_ID);
    expect(summary?.commands).toEqual(["install", "list", "remove", "update"]);
    // A client runs these off the request path, so a clone or an npm install can report progress.
    expect(registry.longCommands()).toContain(`${PACKAGES_HOST_EXTENSION_ID}/install`);
    expect(registry.longCommands()).toContain(`${PACKAGES_HOST_EXTENSION_ID}/update`);
    expect(registry.longCommands()).not.toContain(`${PACKAGES_HOST_EXTENSION_ID}/list`);
  });

  it("installs a local folder, lists it and removes it again", async () => {
    const home = await scratch();
    const project = await scratch();
    const source = await packageFolder(await scratch());
    const { events, registry, refreshExtensionPackages } = harness(project);
    await registry.activate(createPackagesHostExtension({ home }));

    const installed = await registry.invoke(PACKAGES_HOST_EXTENSION_ID, "install", { source, scope: "project" });
    expect(installed).toMatchObject({ installed: { id: "acme.hello", scope: "project" } });
    expect(events.some((event) => event.type === "extension-event" && event.name === "changed")).toBe(true);
    // The host rescans, so approving in Settings is the only step left.
    expect(refreshExtensionPackages).toHaveBeenCalledTimes(1);
    expect((installed as { message: string }).message).toContain("approve it in Settings to start it");
    expect((installed as { message: string }).message).not.toContain("/reload");

    const listed = await registry.invoke(PACKAGES_HOST_EXTENSION_ID, "list") as { packages: Array<{ id?: string }> };
    expect(listed.packages.map((entry) => entry.id)).toEqual(["acme.hello"]);
    expect(describeInstalled({ source, scope: "project", directory: source, id: "acme.hello", version: "1.0.0", signature: { state: "unsigned" } }))
      .toBe("acme.hello 1.0.0 · project · unsigned");

    const removed = await registry.invoke(PACKAGES_HOST_EXTENSION_ID, "remove", { source, scope: "project" }) as { message: string };
    expect(refreshExtensionPackages).toHaveBeenCalledTimes(2);
    expect(removed.message).toBe(`Removed ${source}.`);
    const empty = await registry.invoke(PACKAGES_HOST_EXTENSION_ID, "list") as { packages: unknown[] };
    expect(empty.packages).toEqual([]);

    const updated = await registry.invoke(PACKAGES_HOST_EXTENSION_ID, "update", {}) as { message: string };
    expect(refreshExtensionPackages).toHaveBeenCalledTimes(3);
    expect(updated.message).not.toContain("/reload");
  });

  it("rejects a missing source and an unknown scope", async () => {
    const { registry } = harness(await scratch());
    await registry.activate(createPackagesHostExtension());
    await expect(registry.invoke(PACKAGES_HOST_EXTENSION_ID, "install", {})).rejects.toThrow(/Name a source/u);
    await expect(registry.invoke(PACKAGES_HOST_EXTENSION_ID, "install", { source: "npm:x", scope: "world" })).rejects.toThrow(/"scope" is/u);
  });
});
