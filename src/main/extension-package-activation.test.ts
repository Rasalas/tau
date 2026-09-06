import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GlobalHostEvent } from "../shared/contracts.js";
import { ExtensionPackageActivator } from "./extension-package-activation.js";
import { isPackageGranted, readExtensionGrants } from "./extension-grants.js";
import type { ExtensionManifest, HostPackageLoadResult } from "./extension-packages.js";
import { HostExtensionRegistry, type HostExtensionServices } from "./host-extensions.js";

const dirs: string[] = [];
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-activation-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const manifest: ExtensionManifest = { id: "acme.hello", name: "Hello", permissions: ["workspace:read"], host: "./host.ts" };
const pkg = { scope: "global" as const, directory: "/home/.tau/extensions/hello", manifest };

/** A loader that imports only when the grant allows it, like the real scan. */
function loader(grantsFilePath: string, counters: { imported: number }) {
  return async (): Promise<HostPackageLoadResult> => {
    const granted = isPackageGranted(manifest, (await readExtensionGrants(grantsFilePath)).grants);
    if (!granted) return { extensions: [], ungranted: [pkg], errors: [], skipped: [] };
    counters.imported += 1;
    return {
      extensions: [{
        extension: {
          id: manifest.id,
          name: manifest.name,
          permissions: manifest.permissions,
          activate: (context) => { context.registerCommand("ping", () => "pong"); },
        },
        package: pkg,
      }],
      ungranted: [],
      errors: [],
      skipped: [],
    };
  };
}

async function harness() {
  const grantsFilePath = join(await scratch(), "grants.json");
  const counters = { imported: 0 };
  const events: GlobalHostEvent[] = [];
  const services = { cwd: () => "/project", safeMode: false, log: () => undefined } as unknown as HostExtensionServices;
  const registry = new HostExtensionRegistry(services, (event) => events.push(event));
  const activator = new ExtensionPackageActivator({
    registry,
    load: loader(grantsFilePath, counters),
    cwd: () => "/project",
    agentDir: "/agent",
    bundled: () => false,
    log: () => undefined,
    publish: (event) => events.push(event),
    grantsFilePath,
  });
  return { activator, registry, events, counters, grantsFilePath };
}

describe("ExtensionPackageActivator", () => {
  it("starts a package the moment its grant is written, and tells the client to follow", async () => {
    const { activator, registry, events, counters } = await harness();
    await activator.start();

    // Nothing of the package ran, and the client heard nothing about it yet.
    expect(counters.imported).toBe(0);
    expect(registry.isActive("acme.hello")).toBe(false);
    expect(activator.waitingSummaries(new Set())).toEqual([
      { id: "acme.hello", name: "Hello", active: false, commands: [], isolation: "worker" },
    ]);
    expect(events).toEqual([]);

    await activator.grant("acme.hello", true);

    expect(counters.imported).toBe(1);
    expect(registry.isActive("acme.hello")).toBe(true);
    await expect(registry.invoke("acme.hello", "ping")).resolves.toBe("pong");
    expect(activator.waitingSummaries(new Set())).toEqual([]);
    // The desktop half is built and served by the client, so it has to re-read the set.
    expect(events).toContainEqual({ type: "extension-packages-changed" });
  });

  it("stops both halves again when the grant is taken back", async () => {
    const { activator, registry, events } = await harness();
    await activator.start();
    await activator.grant("acme.hello", true);
    events.length = 0;

    await activator.grant("acme.hello", false);

    expect(registry.isActive("acme.hello")).toBe(false);
    expect(registry.summaries().map((summary) => summary.id)).toEqual([]);
    expect(activator.waitingSummaries(new Set())).toHaveLength(1);
    expect(events).toContainEqual({ type: "extension-packages-changed" });
  });

  it("re-reads the packages on refresh and announces one change per scan", async () => {
    const { activator, events, counters } = await harness();
    await activator.start();
    await activator.grant("acme.hello", true);
    events.length = 0;

    await Promise.all([activator.refresh(), activator.refresh()]);

    // Two callers arriving together share one scan rather than queueing two.
    expect(counters.imported).toBe(2);
    expect(events.filter((event) => event.type === "extension-packages-changed")).toHaveLength(1);
  });
});
