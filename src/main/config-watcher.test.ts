import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FSWatcher } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigWatcher, watchingEnabled, type ConfigChange, type WatchFn } from "./config-watcher.js";

/** A stand-in for `fs.watch` whose events the test fires by hand. */
function fakeWatch() {
  const open = new Map<string, { recursive: boolean; fire: (event: string, filename: string | null) => void; closed: boolean }>();
  const watch: WatchFn = (path, options, listener) => {
    const entry = { recursive: Boolean(options.recursive), fire: listener, closed: false };
    open.set(path, entry);
    const watcher = {
      close: () => { entry.closed = true; open.delete(path); },
      on: () => watcher,
    } as unknown as FSWatcher;
    return watcher;
  };
  return {
    watch,
    paths: () => [...open.keys()].sort(),
    isOpen: (path: string) => open.has(path),
    fire: (path: string, filename: string | null = null, event = "change") => {
      const entry = open.get(path);
      if (!entry) throw new Error(`nothing watches ${path}`);
      entry.fire(event, filename);
    },
  };
}

describe("ConfigWatcher", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("reports one change per root after the quiet period, with every path in the burst", () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const changes: ConfigChange[] = [];
    const watcher = new ConfigWatcher({
      onChange: (change) => changes.push(change),
      watch: fake.watch,
      recursive: true,
      exists: () => true,
      readDirectories: () => [],
    });
    watcher.setTargets([
      { root: "packages", path: "/home/.tau/extensions", directory: true },
      { root: "config", path: "/home/.tau/config.json" },
    ]);

    fake.fire("/home/.tau/extensions", "hello/desktop.tsx");
    fake.fire("/home/.tau/extensions", "hello/styles.css");
    vi.advanceTimersByTime(299);
    expect(changes).toEqual([]);

    fake.fire("/home/.tau/config.json", "config.json");
    vi.advanceTimersByTime(300);
    expect(changes).toEqual([
      { root: "packages", paths: ["/home/.tau/extensions/hello/desktop.tsx", "/home/.tau/extensions/hello/styles.css"] },
      { root: "config", paths: ["/home/.tau/config.json"] },
    ]);
    watcher.close();
  });

  it("watches the nearest existing ancestor of a path that is not there yet, and picks the path up once it appears", () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const present = new Set(["/home"]);
    const changes: ConfigChange[] = [];
    const watcher = new ConfigWatcher({
      onChange: (change) => changes.push(change),
      watch: fake.watch,
      recursive: true,
      exists: (path) => present.has(path),
      readDirectories: () => [],
    });
    watcher.setTargets([{ root: "themes", path: "/home/.tau/themes", directory: true }]);
    expect(fake.paths()).toEqual(["/home"]);

    present.add("/home/.tau");
    present.add("/home/.tau/themes");
    fake.fire("/home", ".tau");
    vi.advanceTimersByTime(300);

    expect(changes).toEqual([{ root: "themes", paths: ["/home/.tau/themes"] }]);
    expect(fake.paths()).toEqual(["/home/.tau/themes"]);
    watcher.close();
  });

  it("re-attaches a file watch after a change, because an editor replaces the file it saves", () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const changes: ConfigChange[] = [];
    const watcher = new ConfigWatcher({
      onChange: (change) => changes.push(change),
      watch: fake.watch,
      recursive: true,
      exists: () => true,
      readDirectories: () => [],
    });
    watcher.setTargets([{ root: "keybindings", path: "/home/.pi/agent/keybindings.json" }]);

    fake.fire("/home/.pi/agent/keybindings.json", "keybindings.json", "rename");
    vi.advanceTimersByTime(300);
    expect(changes).toEqual([{ root: "keybindings", paths: ["/home/.pi/agent/keybindings.json"] }]);
    expect(fake.isOpen("/home/.pi/agent/keybindings.json")).toBe(true);

    // The second save only arrives when the watch followed the new file.
    fake.fire("/home/.pi/agent/keybindings.json", "keybindings.json", "rename");
    vi.advanceTimersByTime(300);
    expect(changes).toHaveLength(2);
    watcher.close();
  });

  it("watches each package folder itself where the platform cannot follow a tree", () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const folders = ["hello", "world"];
    const changes: ConfigChange[] = [];
    const watcher = new ConfigWatcher({
      onChange: (change) => changes.push(change),
      watch: fake.watch,
      recursive: false,
      exists: () => true,
      readDirectories: () => [...folders],
    });
    watcher.setTargets([{ root: "packages", path: "/ext", directory: true }]);
    expect(fake.paths()).toEqual(["/ext", "/ext/hello", "/ext/world"]);

    fake.fire("/ext/hello", "desktop.tsx");
    vi.advanceTimersByTime(300);
    expect(changes).toEqual([{ root: "packages", paths: ["/ext/hello/desktop.tsx"] }]);

    // A folder added later gets a watch when the parent's event is flushed.
    folders.push("third");
    fake.fire("/ext", "third");
    vi.advanceTimersByTime(300);
    expect(fake.paths()).toEqual(["/ext", "/ext/hello", "/ext/third", "/ext/world"]);
    watcher.close();
  });

  it("ignores build output and editor scratch files", () => {
    vi.useFakeTimers();
    const fake = fakeWatch();
    const changes: ConfigChange[] = [];
    const watcher = new ConfigWatcher({
      onChange: (change) => changes.push(change),
      watch: fake.watch,
      recursive: true,
      exists: () => true,
      readDirectories: () => [],
    });
    watcher.setTargets([{ root: "packages", path: "/checkout/kits", directory: true }]);
    fake.fire("/checkout/kits", join("hello", "node_modules", "left-pad", "index.js"));
    fake.fire("/checkout/kits", join("hello", "host.ts~"));
    vi.advanceTimersByTime(300);
    expect(changes).toEqual([]);
    watcher.close();
  });

  it("drops every watch on close", () => {
    const fake = fakeWatch();
    const watcher = new ConfigWatcher({
      onChange: () => undefined,
      watch: fake.watch,
      recursive: true,
      exists: () => true,
      readDirectories: () => [],
    });
    watcher.setTargets([{ root: "packages", path: "/ext", directory: true }]);
    expect(fake.paths()).toEqual(["/ext"]);
    watcher.close();
    expect(fake.paths()).toEqual([]);
  });
});

describe("ConfigWatcher on a real folder", () => {
  it("reports a file written into a watched folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "tau-watch-"));
    const extensions = join(root, ".tau", "extensions");
    const changes: ConfigChange[] = [];
    let resolveFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const watcher = new ConfigWatcher({
      onChange: (change) => { changes.push(change); resolveFirst?.(); },
      debounceMs: 20,
    });
    // The folder does not exist yet: the watcher has to find it when it appears.
    watcher.setTargets([{ root: "packages", path: extensions, directory: true }]);
    mkdirSync(extensions, { recursive: true });
    // fs.watch delivers a folder's own events as soon as it is attached; writing
    // until the first change arrives keeps the test independent of that timing.
    const writing = setInterval(() => writeFileSync(join(extensions, "hello.tsx"), `export default ${Date.now()};\n`), 25);
    try {
      await first;
    } finally {
      clearInterval(writing);
      watcher.close();
      rmSync(root, { recursive: true, force: true });
    }
    expect(changes[0]?.root).toBe("packages");
  });
});

describe("watchingEnabled", () => {
  it("is on by default, off for TAU_NO_WATCH=1 and off when the config says so", () => {
    expect(watchingEnabled({}, {})).toBe(true);
    expect(watchingEnabled({ extensions: { watch: true } }, {})).toBe(true);
    expect(watchingEnabled({ extensions: { watch: false } }, {})).toBe(false);
    expect(watchingEnabled({ extensions: { watch: true } }, { TAU_NO_WATCH: "1" })).toBe(false);
  });
});
