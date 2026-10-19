// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionRegistry, type DesktopExtension } from "./extension-system";
import type { DesktopExtensionLoadResult } from "../shared/contracts";
import { DEFERRED_SHARED_MODULES, SHARED_MODULE_SPECIFIERS } from "../shared/shared-modules";
import { RuntimeExtensions, SHARED_MODULES, isDesktopExtension, loadTauApi, needsNewerClient, sharedExportNames, type RuntimeExtensionHost } from "./runtime-extensions";
import { DESKTOP_BUNDLE_REJECTION_MESSAGES, trustedDesktopBundles } from "../shared/trusted-desktop-bundles";
import { createMemoryStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";

afterEach(() => {
  document.head.querySelectorAll("[data-tau-extension]").forEach((element) => element.remove());
});

function host(bundles: Array<{ path: string; module: unknown }>, extra: Partial<RuntimeExtensionHost> = {}) {
  const log = vi.fn();
  const notify = vi.fn();
  const modules = new Map(bundles.map((entry) => [entry.path, entry.module]));
  return {
    log,
    notify,
    toast: vi.fn(),
    openSettings: vi.fn(),
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
      toast: vi.fn(),
      openSettings: vi.fn(),
      log,
      ...extra,
    },
  };
}

describe("runtime desktop extensions", () => {
  describe("extensions this client turned away", () => {
    /** A machine's extensions this client refuses: `changed` ones also ship here, with other code; `missing` ones do not. */
    function refusing(changed: string[], missing: string[] = [], accepted: string[] = []) {
      const shipped = (id: string) => ({ id, path: `/local/${id}/desktop.js`, scope: "bundled" as const, code: "export default {};", permissions: [] });
      const remote = (id: string, code: string) => ({ ...shipped(id), path: `/machine/${id}/desktop.js`, code });
      const toast = vi.fn();
      const importModule = vi.fn(async () => ({}));
      const bundles = [...changed.map((id) => remote(id, "changed();")), ...missing.map((id) => remote(id, "other();")), ...accepted.map((id) => remote(id, "export default {};"))];
      const h: RuntimeExtensionHost = {
        ...host([]).host,
        toast,
        importModule,
        load: () => trustedDesktopBundles({ bundles, errors: [], skipped: [] }, [...changed, ...accepted].map(shipped), async (source) => source),
      };
      return { h, toast, importModule };
    }
    const lines = (toast: ReturnType<typeof vi.fn>) => toast.mock.calls.map(([options]) => `${options.title} | ${options.description}`);

    it("offers updates for mismatched extensions without loading their code or repeating the notice", async () => {
      const { h, toast, importModule } = refusing(["tau.terminal", "tau.files", "tau.agents", "tau.search", "tau.plan"]);
      const runtime = new RuntimeExtensions(new ExtensionRegistry(), h);
      await runtime.sync("/first-project");
      await runtime.sync("/second-project");
      await runtime.resync();
      await runtime.resync(["tau.terminal", "tau.files"]);
      expect(importModule).not.toHaveBeenCalled();
      expect(lines(toast)).toEqual([
        "Extensions need an update | Use the same Tau version on this app and the connected machine.",
      ]);
      expect(toast.mock.calls[0]?.[0]).toMatchObject({ type: "warning", timeoutMs: 0 });
      const [action] = toast.mock.calls[0]?.[0].actions ?? [];
      expect(action).toMatchObject({ label: "Open updates" });
      expect(action.opens).not.toBe(true);
      expect(h.openSettings).not.toHaveBeenCalled();
      action.run();
      expect(h.openSettings).toHaveBeenCalledWith("about#setting-check-for-updates");
    });

    it("tells another version from an extension this app does not include", async () => {
      const toasts = async (changed: string[], missing: string[]) => {
        const { h, toast } = refusing(changed, missing);
        await new RuntimeExtensions(new ExtensionRegistry(), h).sync("/project");
        return lines(toast);
      };
      expect(await toasts(["tau.html-pages"], [])).toEqual([
        "An extension needs an update | Use the same Tau version on this app and the connected machine.",
      ]);
      expect(await toasts([], ["acme.weather", "acme.map_tiles"])).toEqual([
        "Some extensions weren't loaded | This app does not include Weather and Map Tiles.",
      ]);
      expect(await toasts(["tau.terminal", "tau.files"], ["acme.weather"])).toEqual([
        "Extensions need an update | Use the same Tau version on this app and the connected machine. Not included in this app: Weather.",
      ]);
    });

    it("offers updates for mixed refusals and no update action for missing extensions alone", async () => {
      const { h, toast } = refusing(["tau.terminal"], ["acme.weather"]);
      await new RuntimeExtensions(new ExtensionRegistry(), h).sync("/project");
      toast.mock.calls[0]?.[0].actions[0].run();
      expect(h.openSettings).toHaveBeenCalledWith("about#setting-check-for-updates");

      const missing = refusing([], ["acme.weather"]);
      await new RuntimeExtensions(new ExtensionRegistry(), missing.h).sync("/project");
      expect(missing.toast.mock.calls[0]?.[0].actions).toBeUndefined();
    });

    it("keeps a failed build in a notice of its own", async () => {
      const toast = vi.fn();
      const h: RuntimeExtensionHost = {
        ...host([]).host,
        toast,
        load: async () => ({
          bundles: [],
          errors: [
            { path: "/k/my-kit/desktop.tsx", message: "desktop.tsx:3:7: boom" },
            { path: "/machine/tau.terminal/desktop.js", message: DESKTOP_BUNDLE_REJECTION_MESSAGES.changed },
          ],
          skipped: [],
        }),
      };
      await new RuntimeExtensions(new ExtensionRegistry(), h).sync("/project");
      expect(lines(toast)).toEqual([
        "my-kit/desktop.tsx did not build | desktop.tsx:3:7: boom. The version that was running stays.",
        "An extension needs an update | Use the same Tau version on this app and the connected machine.",
      ]);
    });

    it("stays closed once the user closed it, in a new run too, until another extension is turned away", async () => {
      const storage = createMemoryStorage();
      const run = async (changed: string[]) => {
        const { h, toast } = refusing(changed);
        await new RuntimeExtensions(new ExtensionRegistry(), { ...h, storage }).sync("/project");
        return toast;
      };
      const first = await run(["tau.terminal", "tau.files"]);
      expect(first).toHaveBeenCalledTimes(1);
      // A run that ended with the notice still open asks again.
      expect(await run(["tau.terminal", "tau.files"])).toHaveBeenCalledTimes(1);
      expect(storage.get(STORAGE_KEYS.unavailableExtensions)).toBeNull();

      first.mock.calls[0]?.[0].onClose();
      expect(JSON.parse(storage.get(STORAGE_KEYS.unavailableExtensions) ?? "null")).toEqual(["tau.terminal", "tau.files"]);
      expect(await run(["tau.terminal", "tau.files"])).not.toHaveBeenCalled();
      expect(await run(["tau.files"])).not.toHaveBeenCalled();

      const grown = await run(["tau.terminal", "tau.files", "tau.search"]);
      expect(lines(grown)).toEqual(["An extension needs an update | Use the same Tau version on this app and the connected machine."]);
      grown.mock.calls[0]?.[0].onClose();
      expect(await run(["tau.terminal", "tau.files", "tau.search"])).not.toHaveBeenCalled();
    });

    it("names an extension again once it has loaded in between", async () => {
      const storage = createMemoryStorage();
      const run = async (changed: string[], accepted: string[] = []) => {
        const { h, toast } = refusing(changed, [], accepted);
        await new RuntimeExtensions(new ExtensionRegistry(), { ...h, storage }).sync("/project");
        return toast;
      };
      (await run(["tau.terminal"])).mock.calls[0]?.[0].onClose();
      expect(await run(["tau.terminal"])).not.toHaveBeenCalled();
      expect(await run([], ["tau.terminal"])).not.toHaveBeenCalled();
      expect(JSON.parse(storage.get(STORAGE_KEYS.unavailableExtensions) ?? "null")).toEqual([]);
      expect(lines(await run(["tau.terminal"]))).toEqual([
        "An extension needs an update | Use the same Tau version on this app and the connected machine.",
      ]);
    });

    it("stays closed for the rest of the run when the machine has no store", async () => {
      const { h, toast } = refusing(["tau.terminal"]);
      const runtime = new RuntimeExtensions(new ExtensionRegistry(), h);
      await runtime.sync("/project");
      toast.mock.calls[0]?.[0].onClose();
      await runtime.sync("/other-project");
      expect(toast).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a module whose id differs from its package manifest", async () => {
    const activate = vi.fn();
    const { host: h, notify } = host([]);
    const registry = new ExtensionRegistry();
    await new RuntimeExtensions(registry, {
      ...h,
      load: async () => ({ bundles: [{ id: "acme.expected", manifestId: "acme.expected", path: "/package/desktop.ts", scope: "global", code: "", permissions: [] }], errors: [], skipped: [] }),
      importModule: async () => ({ default: { id: "acme.other", name: "Other", activate } }),
    }).sync("/project");
    expect(activate).not.toHaveBeenCalled();
    expect(registry.getExtensionSummaries()).toEqual([]);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("does not match manifest id"), "error");
  });
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
    expect(activate).toHaveBeenCalledTimes(1);
  });

  it("keeps a loaded module on an unchanged sync", async () => {
    const registry = new ExtensionRegistry();
    const activate = vi.fn((plugin: { registerCommand(command: { id: string; label: string; group: string; run(): void }): void }) => {
      plugin.registerCommand({ id: "hello.run", label: "Hello", group: "Extensions", run: () => {} });
    });
    const { host: h, log } = host([{ path: "/x/hello.tsx", module: { default: { id: "x.hello", name: "Hello", activate } } }]);
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    expect(registry.getCommands().map((command) => command.id)).toContain("hello.run");
    await runtime.sync("/project");
    expect(activate).toHaveBeenCalledTimes(1);
    expect(registry.getCommands().filter((command) => command.id === "hello.run")).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("desktop-extension.loaded", expect.stringContaining("Hello"));
  });

  it("keeps unchanged sidebar contributions and their stylesheet throughout a workspace switch", async () => {
    const registry = new ExtensionRegistry();
    const dispose = vi.fn();
    const activate = vi.fn(() => dispose);
    const { host: h } = host([{ path: "/x/rail.tsx", module: { default: { id: "x.rail", name: "Rail", activate } } }]);
    const originalLoad = h.load;
    h.load = async (...args: Parameters<RuntimeExtensionHost["load"]>) => {
      const result = await originalLoad(...args);
      return { ...result, bundles: result.bundles.map((bundle) => Object.assign(bundle, { styles: ".rail { gap: 2px; }" })) };
    };
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    const sheet = document.head.querySelector('[data-tau-extension="x.rail"]');
    expect(sheet).not.toBeNull();
    const importModule = vi.fn(h.importModule);
    h.importModule = importModule;
    await runtime.sync("/project/worktree");
    await runtime.resync();
    expect(dispose).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(importModule).not.toHaveBeenCalled();
    expect(document.head.querySelector('[data-tau-extension="x.rail"]')).toBe(sheet);
    registry.deactivate("x.rail");
  });

  it("replaces changed bundles, revokes approval and removes packages that left the workspace", async () => {
    const registry = new ExtensionRegistry();
    const dispose = vi.fn();
    const activate = vi.fn(() => dispose);
    let code = "first";
    let granted = true;
    let present = true;
    const { host: h } = host([{ path: "/x/rail.tsx", module: { default: { id: "x.rail", name: "Rail", activate } } }]);
    const originalLoad = h.load;
    h.load = async (...args: Parameters<RuntimeExtensionHost["load"]>) => {
      const result = await originalLoad(...args);
      return { ...result, bundles: present ? result.bundles.map((bundle) => Object.assign(bundle, { code, granted })) : [] };
    };
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    code = "second";
    await runtime.resync();
    expect(activate).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    granted = false;
    await runtime.resync();
    expect(registry.isActive("x.rail")).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(2);
    present = false;
    await runtime.sync("/elsewhere");
    expect(runtime.list()).toEqual([]);
  });

  it("reports a module without a valid default export instead of throwing", async () => {
    const registry = new ExtensionRegistry();
    const { host: h, notify } = host([{ path: "/x/broken.tsx", module: { default: { id: "" } } }]);
    await new RuntimeExtensions(registry, h).sync("/project");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("broken.tsx"), "error");
    expect(registry.getExtensionSummaries()).toHaveLength(0);
  });

  it("leaves a bundle that needs a newer extension API than this client's off, without a notice", async () => {
    const registry = new ExtensionRegistry();
    const activate = vi.fn();
    const imported = vi.fn();
    const { host: h, notify, log } = host([]);
    const load = async (): Promise<DesktopExtensionLoadResult> => ({
      bundles: [{ id: "x.later", path: "/x/later/desktop.js", scope: "bundled", code: "", permissions: [], engines: { api: "^99.0.0" } }],
      errors: [],
      skipped: [],
    });
    await new RuntimeExtensions(registry, { ...h, load, importModule: async () => { imported(); return { default: { id: "x.later", name: "Later", activate } }; } }).sync("/project");
    expect(imported).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("desktop-extension.deferred", expect.stringContaining("x.later"));
  });

  it("compares a bundle's engines.api with the client's own API", () => {
    const bundle = (api?: string) => ({ id: "x", path: "/x", scope: "bundled" as const, code: "", permissions: [], ...(api ? { engines: { api } } : {}) });
    expect(needsNewerClient(bundle("^1.53.0"), "1.52.0")).toBe(true);
    expect(needsNewerClient(bundle("^1.53.0"), "1.57.0")).toBe(false);
    expect(needsNewerClient(bundle(), "1.0.0")).toBe(false);
    expect(needsNewerClient(bundle("not a range"), "1.0.0")).toBe(false);
  });

  it("does not evaluate an ungranted bundle, including on a narrowed resync", async () => {
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
      importModule: vi.fn(async () => ({ default: { id: "x.ungranted", name: "Ungranted", activate } })),
      isEnabled: () => true,
      notify: vi.fn(),
      toast: vi.fn(),
      openSettings: vi.fn(),
      log: vi.fn(),
    };
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    await runtime.resync(["x.ungranted"]);
    expect(h.importModule).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(registry.getExtensionSummaries()).toEqual([]);
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
      toast: vi.fn(),
      openSettings: vi.fn(),
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
      toast: vi.fn(),
      openSettings: vi.fn(),
      log: vi.fn(),
    };
    const synced = new RuntimeExtensions(registry, h).sync("/project");
    const link = () => document.head.querySelector<HTMLLinkElement>('link[data-tau-extension="x.styled"]');
    await vi.waitFor(() => expect(link()).not.toBeNull());
    expect(registry.isLoadingExtensions()).toBe(true);
    link()!.dispatchEvent(new Event("load"));
    await synced;
    expect(registry.isLoadingExtensions()).toBe(false);
    expect(link()?.href).toBe("tau-ext://bundles/x.styled/def456.css");

    registry.setActive("x.styled", false);
    expect(link()).toBeNull();
    registry.setActive("x.styled", true);
    expect(link()?.href).toBe("tau-ext://bundles/x.styled/def456.css");
    registry.deactivate("x.styled");
    expect(link()).toBeNull();
  });

  it("publishes exactly the specifiers both bundlers are built from", async () => {
    await loadTauApi();
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
        toast: vi.fn(),
        openSettings: vi.fn(),
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
    expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringContaining("Unexpected token") }));
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
    // The only action opens, so the toast is tapped as a whole.
    expect(shown.actions).toMatchObject([{ label: "Details", opens: true }]);
    shown.actions[0]?.run();
    expect(openSettings).toHaveBeenCalledWith("inspector");
    expect(h.log).toHaveBeenCalledWith("desktop-extension.failed", "/k/my-kit/desktop.tsx: desktop.tsx:3:7: … full text");
    expect(registry.getLoadFailures()).toEqual([{ path: "/k/my-kit/desktop.tsx", message: "desktop.tsx:3:7: … full text" }]);
  });

  it("says a reloaded package waits for approval instead of saying it reloaded", async () => {
    const registry = new ExtensionRegistry();
    const { host: base, modules } = partialHost(["x.hello"]);
    modules.set("x.hello", { default: { id: "x.hello", name: "Hello", activate: vi.fn() } });
    const toast = vi.fn();
    const openSettings = vi.fn();
    let granted = true;
    const h = {
      ...base,
      toast,
      openSettings,
      load: async (cwd: string, shared: Record<string, string[]>, only?: readonly string[]) => {
        const result = await base.load(cwd, shared, only);
        return { ...result, bundles: result.bundles.map((bundle) => ({ ...bundle, granted })) };
      },
    };
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    granted = false;
    modules.set("x.hello", { default: { id: "x.hello", name: "Hello", activate: vi.fn() } } as never);
    await runtime.resync(["x.hello"]);
    expect(h.notify).not.toHaveBeenCalledWith("Reloaded Hello");
    const shown = toast.mock.calls.at(-1)?.[0] as { id: string; type: string; title: string; actions: Array<{ run(): void }> };
    expect(shown).toMatchObject({ id: "approval:x.hello", type: "warning", title: "Hello is waiting for approval" });
    expect(shown.actions).toMatchObject([{ label: "Review", opens: true }]);
    shown.actions[0]?.run();
    expect(openSettings).toHaveBeenCalledWith("extensions/x.hello");
    // A host-only package the host reports as waiting gets the same toast.
    await runtime.resync(["x.other"], { awaitingApproval: [{ id: "x.other", name: "Other" }] });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ id: "approval:x.other", title: "Other is waiting for approval" }));
  });

  it("does not say a package waits for a changed approval when it never ran", async () => {
    const registry = new ExtensionRegistry();
    const { host: base, modules } = partialHost(["x.hello"]);
    modules.set("x.hello", { default: { id: "x.hello", name: "Hello", activate: vi.fn() } });
    const toast = vi.fn();
    const h = {
      ...base,
      toast,
      load: async (cwd: string, shared: Record<string, string[]>, only?: readonly string[]) => {
        const result = await base.load(cwd, shared, only);
        return { ...result, bundles: result.bundles.map((bundle) => ({ ...bundle, granted: false })) };
      },
    };
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    await runtime.resync(["x.hello"]);
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ id: "approval:x.hello" }));
  });

  it("toasts a host half that did not compile, which the host reports with the change", async () => {
    const registry = new ExtensionRegistry();
    const { host: base } = partialHost(["x.hello"]);
    const toast = vi.fn();
    const runtime = new RuntimeExtensions(registry, { ...base, toast });
    await runtime.sync("/project");
    await runtime.resync(["x.hello"], { buildErrors: [{ path: "/k/my-kit/host.ts", message: "host.ts:2:1: boom", diagnostics: [{ file: "host.ts", line: 2, column: 1, text: "boom" }] }] });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "my-kit/host.ts did not build", description: "host.ts:2:1: boom. The version that was running stays." }));
    expect(base.log).toHaveBeenCalledWith("host-extension.build.failed", "/k/my-kit/host.ts: host.ts:2:1: boom");
  });
});

describe("theme packages", () => {
  it("keeps a retained theme after a newly added kit's stylesheet", async () => {
    const registry = new ExtensionRegistry();
    const h: RuntimeExtensionHost = host([]).host;
    let added = false;
    h.load = async () => ({
      bundles: [
        { id: "theme", path: "/theme", scope: "global", code: "", styles: ":root {}", theme: true, permissions: [] },
        ...(added ? [{ id: "kit", path: "/kit", scope: "bundled" as const, code: "", styles: ".kit {}", permissions: [] }] : []),
      ], errors: [], skipped: [],
    });
    h.importModule = async (bundle) => ({ default: { id: bundle.id, name: bundle.id, activate() {} } });
    const runtime = new RuntimeExtensions(registry, h);
    await runtime.sync("/project");
    const theme = document.head.querySelector('[data-tau-extension="theme"]');
    added = true;
    await runtime.resync();
    expect([...document.head.querySelectorAll("[data-tau-extension]")].map((sheet) => sheet.getAttribute("data-tau-extension"))).toEqual(["kit", "theme"]);
    expect(document.head.querySelector('[data-tau-extension="theme"]')).toBe(theme);
    registry.deactivate("kit");
    registry.deactivate("theme");
  });

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
      toast: vi.fn(),
      openSettings: vi.fn(),
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
      toast: vi.fn(),
      openSettings: vi.fn(),
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
        toast: vi.fn(),
        openSettings: vi.fn(),
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
