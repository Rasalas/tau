import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FSWatcher } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigWatcher, type WatchFn } from "./config-watcher.js";
import { WorkspaceWatch, type ConfigChangeKind } from "./workspace-watch.js";

const dirs: string[] = [];
async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** A watcher whose events the test fires, standing in for the platform's. */
function fake() {
  // One path can carry several watches — two missing folders can share the
  // ancestor they wait on — and the platform delivers to all of them.
  const open = new Map<string, Array<(event: string, filename: string | null) => void>>();
  const watch: WatchFn = (path, _options, listener) => {
    const listeners = open.get(path) ?? [];
    open.set(path, [...listeners, listener]);
    const watcher = {
      close: () => { open.set(path, (open.get(path) ?? []).filter((entry) => entry !== listener)); },
      on: () => watcher,
    } as unknown as FSWatcher;
    return watcher;
  };
  return {
    watch,
    fire: (path: string, filename: string | null = null) => {
      const listeners = open.get(path) ?? [];
      if (listeners.length === 0) throw new Error(`nothing watches ${path}; open: ${[...open.keys()].join(", ")}`);
      for (const listener of [...listeners]) listener("change", filename);
    },
  };
}

async function harness(enabled?: () => boolean) {
  const home = await scratch("tau-watch-home-");
  const project = await scratch("tau-watch-project-");
  const extensions = join(home, ".tau", "extensions");
  await mkdir(join(extensions, "hello"), { recursive: true });
  await writeFile(join(extensions, "hello", "tau-extension.json"), JSON.stringify({
    id: "acme.hello", name: "Hello", desktop: "./desktop.tsx",
  }));
  await writeFile(join(extensions, "hello", "desktop.tsx"), "export default {};\n");
  await writeFile(join(extensions, "notes.tsx"), "export default {};\n");
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "keybindings.json"), "{}");

  const refreshed: string[][] = [];
  const changes: Array<{ kind: ConfigChangeKind; paths: readonly string[] }> = [];
  const platform = fake();
  const watch = new WorkspaceWatch({
    cwd: () => project,
    home,
    agentDir,
    refreshPackages: async (ids) => { refreshed.push([...ids].sort()); },
    configChanged: (change) => changes.push(change),
    ...(enabled ? { enabled } : {}),
    createWatcher: (options) => new ConfigWatcher({
      ...options,
      watch: platform.watch,
      recursive: true,
      readDirectories: () => [],
    }),
  });
  await watch.retarget();
  return { watch, platform, refreshed, changes, home, project, extensions, agentDir };
}

describe("WorkspaceWatch", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("reloads the package a changed file belongs to, by manifest id", async () => {
    const { watch, platform, refreshed, extensions } = await harness();

    platform.fire(extensions, join("hello", "desktop.tsx"));
    await vi.waitFor(() => expect(refreshed).toEqual([["acme.hello"]]));
    watch.close();
  });

  it("reloads a loose extension file under its own id", async () => {
    const { watch, platform, refreshed, extensions } = await harness();

    platform.fire(extensions, "notes.tsx");
    await vi.waitFor(() => expect(refreshed).toEqual([["local.notes"]]));
    watch.close();
  });

  it("reports themes, keybindings and config instead of reloading anything", async () => {
    const { watch, platform, refreshed, changes, home, agentDir } = await harness();

    platform.fire(join(agentDir, "keybindings.json"), "keybindings.json");
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toEqual({ kind: "keybindings", paths: [join(agentDir, "keybindings.json")] });

    // The themes folder and the config file do not exist yet, so both watches
    // sit on the `.tau` folder that does; each group is still reported as its own.
    platform.fire(join(home, ".tau"), "themes");
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(2));
    expect(changes.slice(1).map((change) => change.kind).sort()).toEqual(["config", "themes"]);
    expect(refreshed).toEqual([]);
    watch.close();
  });

  it("watches nothing while extensions.watch is off, and everything again once it is on", async () => {
    let on = false;
    const { watch, platform, refreshed, extensions } = await harness(() => on);
    expect(() => platform.fire(extensions, "notes.tsx")).toThrow(/nothing watches/u);

    on = true;
    await watch.retarget();
    platform.fire(extensions, "notes.tsx");
    await vi.waitFor(() => expect(refreshed).toEqual([["local.notes"]]));

    on = false;
    await watch.retarget();
    expect(() => platform.fire(extensions, "notes.tsx")).toThrow(/nothing watches/u);
    watch.close();
  });

  it("names a package folder that was deleted, from what it read before", async () => {
    const { watch, platform, refreshed, extensions } = await harness();

    platform.fire(extensions, join("hello", "desktop.tsx"));
    await vi.waitFor(() => expect(refreshed).toHaveLength(1));

    await rm(join(extensions, "hello"), { recursive: true, force: true });
    platform.fire(extensions, join("hello", "desktop.tsx"));
    await vi.waitFor(() => expect(refreshed).toEqual([["acme.hello"], ["acme.hello"]]));
    watch.close();
  });
});
