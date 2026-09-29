import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GlobalHostEvent } from "../shared/contracts.js";
import { ExtensionPackageActivator } from "./extension-package-activation.js";
import { grantPackage, isPackageGranted, readExtensionGrants } from "./extension-grants.js";
import type { HostPackageLoadResult } from "./extension-packages.js";
import { HostExtensionRegistry, type HostExtensionServices } from "./host-extensions.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-activation-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** One package folder as the scan would report it, with the hash of its compiled entry. */
interface Installed {
  id: string;
  name: string;
  permissions: string[];
  hash: string;
}

async function harness() {
  const grantsFilePath = join(await scratch(), "grants.json");
  const disk = new Map<string, Installed>();
  /** How often each package's `activate` ran; a restart is what this counts. */
  const activations = new Map<string, number>();
  let instances = 0;
  const events: GlobalHostEvent[] = [];
  const services = { cwd: () => "/project", safeMode: false, log: () => undefined } as unknown as HostExtensionServices;
  const registry = new HostExtensionRegistry(services, (event) => events.push(event));

  /** Packages whose folder no longer compiles; the scan reports an error instead of a half. */
  const failing = new Set<string>();

  const load = async (): Promise<HostPackageLoadResult> => {
    const grants = (await readExtensionGrants(grantsFilePath)).grants;
    const result: HostPackageLoadResult = { extensions: [], ungranted: [], errors: [], skipped: [] };
    for (const entry of disk.values()) {
      if (failing.has(entry.id)) {
        result.errors.push({ path: `/home/.tau/extensions/${entry.id}/host.ts`, id: entry.id, message: "host.ts:1:1: Unexpected end of file", diagnostics: [{ file: "host.ts", line: 1, column: 1, text: "Unexpected end of file" }] });
        continue;
      }
      const manifest = { id: entry.id, name: entry.name, permissions: entry.permissions, host: "./host.ts" };
      const pkg = { scope: "global" as const, directory: `/home/.tau/extensions/${entry.id}`, manifest };
      if (!isPackageGranted(manifest, grants)) {
        result.ungranted.push(pkg);
        continue;
      }
      // A fresh object per scan, exactly as compiling and importing would produce.
      const instance = ++instances;
      result.extensions.push({
        extension: {
          id: entry.id,
          name: entry.name,
          permissions: entry.permissions,
          activate: (context) => {
            activations.set(entry.id, (activations.get(entry.id) ?? 0) + 1);
            context.registerCommand("which", () => instance);
          },
        },
        package: pkg,
        bundleHash: entry.hash,
        bundlePath: `/cache/${entry.id}-${entry.hash}.cjs`,
      });
    }
    return result;
  };

  const activator = new ExtensionPackageActivator({
    registry,
    load,
    cwd: () => "/project",
    agentDir: "/agent",
    bundled: () => false,
    log: () => undefined,
    publish: (event) => events.push(event),
    grantsFilePath,
  });

  const install = (entry: Installed) => { disk.set(entry.id, entry); };
  const breakEntry = (id: string) => { failing.add(id); };
  const fixEntry = (id: string) => { failing.delete(id); };
  const approve = (id: string) => grantPackage({ id, permissions: disk.get(id)?.permissions ?? [] }, true, grantsFilePath);
  return { activator, registry, events, activations, disk, install, breakEntry, fixEntry, approve, grantsFilePath };
}

const hello: Installed = { id: "acme.hello", name: "Hello", permissions: ["workspace:read"], hash: "1111111111111111" };
const other: Installed = { id: "acme.other", name: "Other", permissions: [], hash: "2222222222222222" };

describe("ExtensionPackageActivator", () => {
  it("starts a package the moment its grant is written, and tells the client to follow", async () => {
    const { activator, registry, events, activations, install } = await harness();
    install(hello);
    await activator.start();

    // Nothing of the package ran, and the client heard nothing about it yet.
    expect(activations.get("acme.hello")).toBeUndefined();
    expect(registry.isActive("acme.hello")).toBe(false);
    expect(activator.waitingSummaries(new Set())).toEqual([
      { id: "acme.hello", name: "Hello", active: false, commands: [], isolation: "worker" },
    ]);
    expect(events).toEqual([]);

    await activator.grant("acme.hello", true);

    expect(activations.get("acme.hello")).toBe(1);
    expect(registry.isActive("acme.hello")).toBe(true);
    await expect(registry.invoke("acme.hello", "which")).resolves.toBe(1);
    expect(activator.waitingSummaries(new Set())).toEqual([]);
    // The desktop half is built and served by the client, so it has to re-read the set.
    expect(events).toContainEqual({ type: "extension-packages-changed" });
  });

  it("leaves a running package alone when another one is installed or approved", async () => {
    const { activator, registry, events, activations, install, approve } = await harness();
    install(hello);
    await approve("acme.hello");
    await activator.start();
    expect(activations.get("acme.hello")).toBe(1);
    const running = await registry.invoke("acme.hello", "which");

    // A second package arrives; the first one's worker and its state must survive it.
    install(other);
    await activator.refresh();

    expect(activations.get("acme.hello")).toBe(1);
    await expect(registry.invoke("acme.hello", "which")).resolves.toBe(running);
    expect(registry.isActive("acme.other")).toBe(false);

    await activator.grant("acme.other", true);

    expect(activations.get("acme.hello")).toBe(1);
    expect(activations.get("acme.other")).toBe(1);
    await expect(registry.invoke("acme.hello", "which")).resolves.toBe(running);
    expect(events.filter((event) => event.type === "extension-packages-changed")).toHaveLength(2);
  });

  it("re-activates only the package an update changed", async () => {
    const { activator, registry, activations, install, approve } = await harness();
    install(hello);
    install(other);
    await approve("acme.hello");
    await approve("acme.other");
    await activator.start();
    const untouched = await registry.invoke("acme.other", "which");

    // A new compiled entry for one package: same id, different code.
    install({ ...hello, hash: "3333333333333333" });
    await activator.refresh();

    expect(activations.get("acme.hello")).toBe(2);
    expect(activations.get("acme.other")).toBe(1);
    await expect(registry.invoke("acme.other", "which")).resolves.toBe(untouched);
  });

  it("restarts every package when the manual reload forces it", async () => {
    const { activator, registry, activations, install, approve } = await harness();
    install(hello);
    await approve("acme.hello");
    await activator.start();
    const first = await registry.invoke("acme.hello", "which");

    await activator.refresh({ force: true });

    expect(activations.get("acme.hello")).toBe(2);
    expect(await registry.invoke("acme.hello", "which")).not.toBe(first);
  });

  it("reloads only the package a watched edit named, and says which one moved", async () => {
    const { activator, registry, events, activations, install, approve } = await harness();
    install(hello);
    install(other);
    await approve("acme.hello");
    await approve("acme.other");
    await activator.start();
    const untouched = await registry.invoke("acme.other", "which");
    events.length = 0;

    // Both folders hold new code; only one of them was edited.
    install({ ...hello, hash: "3333333333333333" });
    install({ ...other, hash: "4444444444444444" });
    await activator.refresh({ only: ["acme.hello"] });

    expect(activations.get("acme.hello")).toBe(2);
    expect(activations.get("acme.other")).toBe(1);
    await expect(registry.invoke("acme.other", "which")).resolves.toBe(untouched);
    expect(events).toContainEqual({ type: "extension-packages-changed", extensionIds: ["acme.hello"] });
  });

  it("hands the client the compile errors of the packages a watched edit reloaded, and no one else's", async () => {
    const { activator, events, install, breakEntry, approve } = await harness();
    install(hello);
    install(other);
    await approve("acme.hello");
    await approve("acme.other");
    await activator.start();
    breakEntry("acme.hello");
    breakEntry("acme.other");
    events.length = 0;
    await activator.refresh({ only: ["acme.hello"] });
    expect(events).toContainEqual({
      type: "extension-packages-changed",
      extensionIds: ["acme.hello"],
      buildErrors: [{ path: "/home/.tau/extensions/acme.hello/host.ts", message: "host.ts:1:1: Unexpected end of file", diagnostics: [{ file: "host.ts", line: 1, column: 1, text: "Unexpected end of file" }] }],
    });
  });

  it("keeps the last good version running when a reload finds a broken package", async () => {
    const { activator, registry, activations, install, breakEntry, fixEntry, approve } = await harness();
    install(hello);
    await approve("acme.hello");
    await activator.start();
    const running = await registry.invoke("acme.hello", "which");

    breakEntry("acme.hello");
    await activator.refresh({ only: ["acme.hello"] });

    // The half that is running is the one that compiled; nothing was restarted
    // and nothing was deactivated over the failure.
    expect(registry.isActive("acme.hello")).toBe(true);
    expect(activations.get("acme.hello")).toBe(1);
    await expect(registry.invoke("acme.hello", "which")).resolves.toBe(running);
    expect(registry.summaries().map((summary) => summary.id)).toEqual(["acme.hello"]);

    // And it is replaced as soon as the file compiles again.
    fixEntry("acme.hello");
    install({ ...hello, hash: "5555555555555555" });
    await activator.refresh({ only: ["acme.hello"] });
    expect(activations.get("acme.hello")).toBe(2);
  });

  it("stops both halves again when the grant is taken back", async () => {
    const { activator, registry, events, install } = await harness();
    install(hello);
    await activator.start();
    await activator.grant("acme.hello", true);
    events.length = 0;

    await activator.grant("acme.hello", false);

    expect(registry.isActive("acme.hello")).toBe(false);
    expect(registry.summaries().map((summary) => summary.id)).toEqual([]);
    expect(activator.waitingSummaries(new Set())).toHaveLength(1);
    expect(events).toContainEqual({ type: "extension-packages-changed" });
  });

  it("shares one scan between refreshes that arrive together", async () => {
    const { activator, events, activations, install, approve } = await harness();
    install(hello);
    await approve("acme.hello");
    await activator.start();
    events.length = 0;

    await Promise.all([activator.refresh(), activator.refresh()]);

    // One announcement, and the unchanged package was never restarted for it.
    expect(events.filter((event) => event.type === "extension-packages-changed")).toHaveLength(1);
    expect(activations.get("acme.hello")).toBe(1);
  });
});
