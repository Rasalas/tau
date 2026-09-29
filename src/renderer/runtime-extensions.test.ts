// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type DesktopExtension } from "./extension-system";
import type { DesktopExtensionLoadResult } from "../shared/contracts";
import { DEFERRED_SHARED_MODULES, SHARED_MODULE_SPECIFIERS } from "../shared/shared-modules";
import { RuntimeExtensions, SHARED_MODULES, isDesktopExtension, sharedExportNames, type RuntimeExtensionHost } from "./runtime-extensions";

function host(bundles: Array<{ path: string; module: unknown }>, extra: Partial<RuntimeExtensionHost> = {}) {
  const log = vi.fn();
  const notify = vi.fn();
  const modules = new Map(bundles.map((entry) => [entry.path, entry.module]));
  return {
    log,
    notify,
    host: {
      load: async () => ({
        bundles: bundles.map((entry) => ({
          id: `x.${entry.path.split("/").pop()}`,
          path: entry.path,
          scope: "global" as const,
          code: "",
          permissions: [],
        })),
        errors: [],
        skipped: [],
      }),
      importModule: async (bundle: { path: string }) => modules.get(bundle.path),
      isEnabled: () => true,
      notify,
      log,
      ...extra,
    },
  };
}

describe("runtime desktop extensions", () => {
  it("re-reads the same workspace on resync, and does nothing before the first sync", async () => {
    const registry = new ExtensionRegistry();
    const activate = vi.fn();
    const { host: h } = host([{ path: "/x/hello.tsx", module: { default: { id: "x.hello", name: "Hello", activate } } }]);
    const load = vi.fn(h.load);
    const runtime = new RuntimeExtensions(registry, { ...h, load });

    await runtime.resync();
    expect(load).not.toHaveBeenCalled();

    await runtime.sync("/project");
    await runtime.resync();

    expect(load.mock.calls.map((call) => call[0])).toEqual(["/project", "/project"]);
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("activates a loaded module and replaces it on the next sync", async () => {
    const registry = new ExtensionRegistry();
    const activate = vi.fn((plugin: { registerCommand(command: { id: string; label: string; group: string; run(): void }): void }) => {
      plugin.registerCommand({ id: "hello.run", label: "Hello", group: "Extensions", run: () => {} });
    });
    const { host: h, log } = host([{ path: "/x/hello.tsx", module: { default: { id: "x.hello", name: "Hello", activate } } }]);
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    expect(registry.getCommands().map((command) => command.id)).toContain("hello.run");
    await runtime.sync("/project");
    expect(activate).toHaveBeenCalledTimes(2);
    expect(registry.getCommands().filter((command) => command.id === "hello.run")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("desktop-extension.loaded", expect.stringContaining("Hello"));
  });

  it("reports a module without a valid default export instead of throwing", async () => {
    const registry = new ExtensionRegistry();
    const { host: h, notify } = host([{ path: "/x/broken.tsx", module: { default: { id: "" } } }]);
    await new RuntimeExtensions(registry, h).sync("/project");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("broken.tsx"));
    expect(registry.getExtensionSummaries()).toHaveLength(0);
  });

  it("keeps an ungranted bundle inactive while registering it as known", async () => {
    const registry = new ExtensionRegistry();
    const activate = vi.fn();
    const h = {
      load: async () => ({
        bundles: [{
          id: "x.ungranted",
          path: "/x/ungranted.tsx",
          scope: "global" as const,
          code: "",
          permissions: ["workspace:read"],
          granted: false,
        }],
        errors: [],
        skipped: [],
      }),
      importModule: async () => ({ default: { id: "x.ungranted", name: "Ungranted", activate } }),
      isEnabled: () => true,
      notify: vi.fn(),
      log: vi.fn(),
    };
    await new RuntimeExtensions(registry, h).sync("/project");
    expect(activate).not.toHaveBeenCalled();
    const summaries = registry.getExtensionSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe("x.ungranted");
    expect(summaries[0].active).toBe(false);
    expect(summaries[0].granted).toBe(false);
    expect(summaries[0].permissions).toEqual(["workspace:read"]);
  });

  it("imports a bundle from the host's tau-ext URL, not from a blob", async () => {
    const registry = new ExtensionRegistry();
    const seen: string[] = [];
    const h = {
      load: async () => ({
        bundles: [{
          id: "x.served",
          path: "/x/served.tsx",
          scope: "global" as const,
          code: "export default { id: 'x.served', name: 'Served', activate() {} };",
          url: "tau-ext://bundles/x.served/abc123.js",
          permissions: [],
          granted: true,
        }],
        errors: [],
        skipped: [],
      }),
      importModule: async (bundle: { url?: string }) => {
        seen.push(bundle.url ?? "<none>");
        return { default: { id: "x.served", name: "Served", activate() {} } };
      },
      isEnabled: () => true,
      notify: vi.fn(),
      log: vi.fn(),
    };
    await new RuntimeExtensions(registry, h).sync("/project");
    expect(seen).toEqual(["tau-ext://bundles/x.served/abc123.js"]);
    expect(registry.getExtensionSummaries()[0]?.active).toBe(true);
  });

  it("links a bundle's stylesheet while the extension is active and takes it away with it", async () => {
    const registry = new ExtensionRegistry();
    const h = {
      load: async () => ({
        bundles: [{
          id: "x.styled",
          path: "/x/styled.tsx",
          scope: "global" as const,
          code: "",
          url: "tau-ext://bundles/x.styled/abc123.js",
          styles: ".styled { color: red; }",
          stylesUrl: "tau-ext://bundles/x.styled/def456.css",
          permissions: [],
          granted: true,
        }],
        errors: [],
        skipped: [],
      }),
      importModule: async () => ({ default: { id: "x.styled", name: "Styled", activate() {} } }),
      isEnabled: () => true,
      notify: vi.fn(),
      log: vi.fn(),
    };
    await new RuntimeExtensions(registry, h).sync("/project");
    const link = () => document.head.querySelector<HTMLLinkElement>('link[data-tau-extension="x.styled"]');
    expect(link()?.href).toBe("tau-ext://bundles/x.styled/def456.css");

    registry.setActive("x.styled", false);
    expect(link()).toBeNull();
    registry.setActive("x.styled", true);
    expect(link()?.href).toBe("tau-ext://bundles/x.styled/def456.css");
    registry.deactivate("x.styled");
    expect(link()).toBeNull();
  });

  it("publishes exactly the specifiers both bundlers are built from", () => {
    const published = new Set([...Object.keys(SHARED_MODULES), ...DEFERRED_SHARED_MODULES]);
    expect([...published].sort()).toEqual([...SHARED_MODULE_SPECIFIERS].sort());
    // Every one of them is reported to the host, deferred ones with no names yet.
    expect(Object.keys(sharedExportNames()).sort()).toEqual([...SHARED_MODULE_SPECIFIERS].sort());
  });

  it("validates the extension shape and lists shared exports", () => {
    expect(isDesktopExtension({ id: "a", name: "A", activate() {} })).toBe(true);
    expect(isDesktopExtension({ id: "a" })).toBe(false);
    const names = sharedExportNames({ react: { useState() {}, useEffect() {} } });
    expect(names.react).toEqual(["useState", "useEffect"]);
  });
});

describe("replacing one extension", () => {
  /** A host whose folders hold these ids, each with a module the test can swap. */
  function partialHost(ids: string[]) {
    const modules = new Map(ids.map((id) => [id, { default: { id, name: id, activate: vi.fn() } }]));
    const broken = new Set<string>();
    const requested: Array<readonly string[] | undefined> = [];
    return {
      modules,
      broken,
      requested,
      host: {
        load: async (_cwd: string, _shared: Record<string, string[]>, only?: readonly string[]) => {
          requested.push(only);
          const wanted = only ? ids.filter((id) => only.includes(id)) : ids;
          return {
            bundles: wanted.filter((id) => !broken.has(id)).map((id) => ({
              id,
              path: `/x/${id}.tsx`,
              scope: "global" as const,
              code: "",
              permissions: [],
            })),
            errors: wanted.filter((id) => broken.has(id)).map((id) => ({ path: `/x/${id}.tsx`, message: "Unexpected token" })),
            skipped: [],
          };
        },
        importModule: async (bundle: { id: string }) => modules.get(bundle.id),
        isEnabled: () => true,
        notify: vi.fn(),
        log: vi.fn(),
      },
    };
  }

  it("swaps the named module and leaves every other extension running", async () => {
    const registry = new ExtensionRegistry();
    const { host: h, modules, requested } = partialHost(["x.hello", "x.other"]);
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    const untouched = runtime.list().find((record) => record.extension.id === "x.other")?.extension;

    const dispose = vi.fn();
    const replacement = { id: "x.hello", name: "Hello v2", activate: vi.fn(() => dispose) };
    modules.set("x.hello", { default: replacement } as never);
    await runtime.resync(["x.hello"]);

    expect(requested).toEqual([undefined, ["x.hello"]]);
    expect(replacement.activate).toHaveBeenCalledTimes(1);
    expect(registry.isActive("x.hello")).toBe(true);
    expect(runtime.list().map((record) => record.extension.name)).toEqual(["Hello v2", "x.other"]);
    // The extension that was not named kept the very object it was activated with.
    expect(runtime.list().find((record) => record.extension.id === "x.other")?.extension).toBe(untouched);
    expect(h.notify).toHaveBeenCalledWith("Reloaded Hello v2");
  });

  it("finds the running module by the id the host named, not by the id the module declares", async () => {
    const registry = new ExtensionRegistry();
    const { host: h, modules } = partialHost(["local.hello-panel"]);
    // A loose file is named by its path; the module inside declares its own id.
    modules.set("local.hello-panel", { default: { id: "example.hello", name: "Hello", activate: vi.fn() } } as never);
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");

    modules.set("local.hello-panel", { default: { id: "example.hello", name: "Hello v2", activate: vi.fn() } } as never);
    await runtime.resync(["local.hello-panel"]);

    expect(runtime.list().map((record) => record.extension.name)).toEqual(["Hello v2"]);
    expect(h.notify).toHaveBeenCalledWith("Reloaded Hello v2");
    expect(h.notify).not.toHaveBeenCalledWith(expect.stringContaining("already taken"));
  });

  it("keeps the running version when the edited file does not build", async () => {
    const registry = new ExtensionRegistry();
    const { host: h, broken } = partialHost(["x.hello"]);
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    const running = runtime.list()[0].extension;

    broken.add("x.hello");
    await runtime.resync(["x.hello"]);

    expect(registry.isActive("x.hello")).toBe(true);
    expect(runtime.list().map((record) => record.extension)).toEqual([running]);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Unexpected token"));
  });

  it("toasts a build error with its file, line and column, and the whole text to copy", async () => {
    const registry = new ExtensionRegistry();
    const { host: base } = partialHost([]);
    const toast = vi.fn();
    const openSettings = vi.fn();
    const diagnostics = [
      { file: "desktop.tsx", line: 3, column: 7, text: "Expected \";\" but found \"y\"", lineText: "const x y = 1;" },
      { file: "title.ts", line: 1, column: 0, text: "Unexpected end of file" },
    ];
    const h = {
      ...base,
      toast,
      openSettings,
      load: async () => ({ bundles: [], errors: [{ path: "/k/my-kit/desktop.tsx", message: "desktop.tsx:3:7: … full text", diagnostics }], skipped: [] }),
    };
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    const shown = toast.mock.calls[0]?.[0] as { type: string; title: string; description: string; copyText: string; actions: Array<{ label: string; run(): void }> };
    expect(shown).toMatchObject({ type: "error", title: "my-kit/desktop.tsx did not build", copyText: "desktop.tsx:3:7: … full text" });
    expect(shown.description).toBe("desktop.tsx:3:7: Expected \";\" but found \"y\" (and 1 more). The version that was running stays.");
    shown.actions[0]?.run();
    expect(openSettings).toHaveBeenCalledWith("inspector");
    expect(h.log).toHaveBeenCalledWith("desktop-extension.failed", "/k/my-kit/desktop.tsx: desktop.tsx:3:7: … full text");
    expect(registry.getLoadFailures()).toEqual([{ path: "/k/my-kit/desktop.tsx", message: "desktop.tsx:3:7: … full text" }]);
  });

  it("toasts a host half that did not compile, which the host reports with the change", async () => {
    const registry = new ExtensionRegistry();
    const { host: base } = partialHost(["x.hello"]);
    const toast = vi.fn();
    const runtime = new RuntimeExtensions(registry, { ...base, toast });
    await runtime.sync("/project");
    await runtime.resync(["x.hello"], [{ path: "/k/my-kit/host.ts", message: "host.ts:2:1: boom", diagnostics: [{ file: "host.ts", line: 2, column: 1, text: "boom" }] }]);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "my-kit/host.ts did not build", description: "host.ts:2:1: boom. The version that was running stays." }));
    expect(base.log).toHaveBeenCalledWith("host-extension.build.failed", "/k/my-kit/host.ts: host.ts:2:1: boom");
  });
});

describe("theme packages", () => {
  it("links a theme's stylesheet after every other one, whatever order it arrived in", async () => {
    const registry = new ExtensionRegistry();
    const themed = {
      load: async () => ({
        bundles: [
          { id: "acme.theme", path: "/x/theme.css", scope: "global" as const, code: "", styles: ":root { --acid: red; }", permissions: [], granted: true, theme: true },
          { id: "tau.kit", path: "/x/kit.tsx", scope: "bundled" as const, code: "", styles: ".kit {}", permissions: [] },
        ],
        errors: [],
        skipped: [],
      }),
      importModule: async (bundle: { id: string }) => ({ default: { id: bundle.id, name: bundle.id, activate() {} } }),
      isEnabled: () => true,
      notify: vi.fn(),
      log: vi.fn(),
    };

    await new RuntimeExtensions(registry, themed).sync("/project");

    const linked = [...document.head.querySelectorAll("[data-tau-extension]")].map((node) => node.getAttribute("data-tau-extension"));
    expect(linked).toEqual(["tau.kit", "acme.theme"]);
  });
});

describe("overlapping syncs", () => {
  interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void; }
  function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>["resolve"];
    let reject!: Deferred<T>["reject"];
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  function extension(id: string, name = id): DesktopExtension {
    return { id, name, activate() {} };
  }

  function result(bundles: DesktopExtensionLoadResult["bundles"]): DesktopExtensionLoadResult {
    return { bundles, errors: [], skipped: [] };
  }

  function bundle(path: string): DesktopExtensionLoadResult["bundles"][number] {
    return { id: `x.${path.split("/").pop()}`, path, scope: "global" as const, code: "", permissions: [] };
  }

  function deferredHost(paths: string[]) {
    const log = vi.fn();
    const notify = vi.fn();
    const imports = paths.map(() => ({ ...deferred<unknown>(), started: deferred<void>() }));
    return {
      log,
      notify,
      imports,
      host: {
        load: async () => result([]),
        importModule: vi.fn((entry: DesktopExtensionLoadResult["bundles"][number]) => {
          const gate = imports[paths.indexOf(entry.path)];
          gate.started.resolve();
          return gate.promise;
        }),
        isEnabled: () => true,
        notify,
        log,
      } satisfies RuntimeExtensionHost,
    };
  }

  it("imports every bundle at once and activates them in the order they came", async () => {
    const registry = new ExtensionRegistry();
    const { host: h, imports } = deferredHost(["/x/a.tsx", "/x/b.tsx"]);
    const runtime = new RuntimeExtensions(registry, { ...h, load: async () => result([bundle("/x/a.tsx"), bundle("/x/b.tsx")]) });
    const activated: string[] = [];
    const a = extension("x.a");
    a.activate = () => { activated.push("a"); };
    const b = extension("x.b");
    b.activate = () => { activated.push("b"); };

    const syncing = runtime.sync("/work");
    await Promise.all(imports.map((gate) => gate.started.promise));
    imports[1].resolve({ default: b });
    imports[0].resolve({ default: a });
    await syncing;
    expect(activated).toEqual(["a", "b"]);
  });

  it.each(["resolve", "reject"] as const)("an obsolete import that %ss leaves the newer sync's extensions alone", async (settlement) => {
    const registry = new ExtensionRegistry();
    const { host: h, imports } = deferredHost(["/x/old.tsx", "/x/new.tsx"]);
    let loadCount = 0;
    const runtime = new RuntimeExtensions(registry, {
      ...h,
      load: async () => {
        loadCount += 1;
        return loadCount === 1 ? result([bundle("/x/old.tsx")]) : result([bundle("/x/new.tsx")]);
      },
    });

    const first = runtime.sync("/old");
    await imports[0].started.promise;
    const second = runtime.sync("/new");
    await imports[1].started.promise;
    const current = extension("x.new", "New");
    const dispose = vi.fn();
    current.activate = vi.fn(() => dispose);
    imports[1].resolve({ default: current });
    const winner = await second;

    if (settlement === "resolve") imports[0].resolve({ default: extension("x.new", "Old") });
    else imports[0].reject(new Error("obsolete import failed"));
    expect(await first).toBe(winner);

    expect(winner.map((record) => record.extension)).toEqual([current]);
    expect(runtime.list()).toBe(winner);
    expect(registry.isActive("x.new")).toBe(true);
    expect(current.activate).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalledWith("desktop-extension.loaded", expect.stringContaining("Old"));
    expect(h.log).not.toHaveBeenCalledWith("desktop-extension.failed", expect.anything());
    expect(h.notify).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("the next sync cleans partial activations before an obsolete import %ss", async (settlement) => {
    const registry = new ExtensionRegistry();
    const { host: h, imports } = deferredHost(["/x/a.tsx", "/x/b.tsx", "/x/unactivated.tsx", "/x/keep.tsx"]);
    const runtime = new RuntimeExtensions(registry, {
      ...h,
      load: async (cwd) => cwd === "/old"
        ? result([bundle("/x/a.tsx"), bundle("/x/b.tsx"), bundle("/x/unactivated.tsx")])
        : result([bundle("/x/keep.tsx")]),
    });
    const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
    const oldDispose = vi.fn();
    const old = extension("x.shared", "Old");
    old.activate = () => oldDispose;
    const newDispose = vi.fn();
    const current = extension("x.shared", "New");
    current.activate = vi.fn(() => newDispose);

    const first = runtime.sync("/old");
    await imports[0].started.promise;
    // All three imports start at once; only the first has arrived.
    await imports[2].started.promise;
    imports[0].resolve({ default: old });
    await settled();
    expect(registry.isActive("x.shared")).toBe(true);
    expect(oldDispose).not.toHaveBeenCalled();

    const second = runtime.sync("/new");
    await imports[3].started.promise;
    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(registry.isActive("x.shared")).toBe(false);
    imports[3].resolve({ default: current });
    const winner = await second;

    if (settlement === "resolve") imports[1].resolve({ default: extension("x.stale", "Stale") });
    else imports[1].reject(new Error("obsolete import failed"));
    imports[2].resolve({ default: extension("x.never", "Never") });
    expect(await first).toBe(winner);
    expect(runtime.list()).toBe(winner);
    expect(winner.map((record) => record.extension)).toEqual([current]);
    expect(registry.isActive("x.stale")).toBe(false);
    expect(registry.isActive("x.shared")).toBe(true);
    expect(oldDispose).toHaveBeenCalledTimes(1);
    expect(newDispose).not.toHaveBeenCalled();
    expect(current.activate).toHaveBeenCalledTimes(1);
    expect(registry.isActive("x.never")).toBe(false);
    expect(h.importModule.mock.calls.map(([entry]) => entry.path)).toEqual(["/x/a.tsx", "/x/b.tsx", "/x/unactivated.tsx", "/x/keep.tsx"]);
    expect(h.notify).not.toHaveBeenCalled();
  });
});
