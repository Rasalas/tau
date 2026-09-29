import * as React from "react";
import * as ReactDom from "react-dom";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactVirtual from "@tanstack/react-virtual";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult, PackageBuildError } from "../shared/contracts";
import type { PackagesChangeReport } from "../workbench/host-events";
import { diagnosticLine } from "../shared/build-diagnostics";
import type { ToastOptions } from "../workbench/toast-store";
import type { DesktopExtension, ExtensionRegistry } from "./extension-system";
import { DEFERRED_SHARED_MODULES, type SharedModuleSpecifier } from "../shared/shared-modules";
import type { Platform } from "../workbench/platform";
import { getPlatform } from "./platform-context";

/**
 * The renderer's own copies of the modules an extension may import by bare
 * name. `src/shared/shared-modules.ts` names them; a specifier missing here is
 * one that has not been loaded yet (see `loadTauApi`, `loadSharedIcons`).
 */
export const SHARED_MODULES: Partial<Record<SharedModuleSpecifier, object>> & Record<string, object> = {
  react: React,
  // `flushSync` and `createPortal` reach into the running root; a second copy
  // of react-dom holds its own internals and silently does nothing.
  "react-dom": ReactDom,
  "react/jsx-runtime": JsxRuntime,
  // The transcript already runs it; a list in a kit shares that copy instead of bundling its own.
  "@tanstack/react-virtual": ReactVirtual,
};

/**
 * The `tau` module is its own chunk: only kits run it, and they load after the
 * first paint. Its names go with every bundle request, so a load waits for it.
 */
let apiModule: Promise<object> | undefined;
export function loadTauApi(): Promise<object> {
  apiModule ??= import("./extension-api").then(
    (module) => (SHARED_MODULES.tau = module),
    (error: unknown) => { apiModule = undefined; throw error; },
  );
  return apiModule;
}

/**
 * The deferred shared modules — the icon set — as their own chunk: a namespace
 * import would put every icon into the initial bundle. Fetched the first time a
 * package actually needs one.
 */
let iconModule: Promise<object> | undefined;
export function loadSharedIcons(): Promise<object> {
  iconModule ??= import("./shared-icons").then(({ sharedIconModule }) => {
    const module = sharedIconModule();
    SHARED_MODULES["lucide-react"] = module;
    return module;
  });
  return iconModule;
}

export function sharedExportNames(modules: Record<string, object> = SHARED_MODULES): Record<string, string[]> {
  const names = Object.fromEntries(Object.entries(modules).map(([name, module]) => [name, Object.keys(module)]));
  // Still a shared specifier before its chunk is loaded; the host fills in the
  // export names from its own copy when the list is empty.
  if (modules === SHARED_MODULES) {
    for (const name of DEFERRED_SHARED_MODULES) names[name] ??= [];
  }
  return names;
}

export function installSharedModules(target: { __tauShared?: Record<string, object> } = globalThis as never): void {
  // oxlint-disable-next-line eslint/no-underscore-dangle -- __tauShared is a cross-file global protocol name (see extension-api.ts, desktop-extensions.ts).
  target.__tauShared = SHARED_MODULES;
  void loadTauApi().catch(() => undefined);
}

export function isDesktopExtension(value: unknown): value is DesktopExtension {
  const candidate = value as Partial<DesktopExtension> | null;
  return Boolean(candidate && typeof candidate.id === "string" && candidate.id.trim()
    && typeof candidate.name === "string" && typeof candidate.activate === "function");
}

export interface RuntimeExtensionRecord {
  extension: DesktopExtension;
  bundle: DesktopExtensionBundle;
}

export interface RuntimeExtensionHost {
  load(cwd: string, sharedExports: Record<string, string[]>, only?: readonly string[]): Promise<DesktopExtensionLoadResult>;
  /** Evaluates a bundle as an ES module; defaults to the host's `tau-ext:` URL. */
  importModule?(bundle: DesktopExtensionBundle): Promise<unknown>;
  isEnabled(id: string): boolean;
  notify(message: string): void;
  /** A toast with a type, lines and actions; without it, `notify` carries the first line. */
  toast?(options: ToastOptions): void;
  /** Opens a place in Settings, for a toast's action. */
  openSettings?(target: string): void;
  log(label: string, detail?: string): void;
}

/** The entry's folder and file, which is what an author recognises: `my-kit/desktop.tsx`. */
function entryLabel(path: string): string {
  return path.split(/[\\/]/u).slice(-2).join("/");
}

/**
 * The desktop host serves every bundle under `tau-ext:`, which is what the CSP
 * allows. The browser preview has no host, so it falls back to a blob URL — the
 * one place a bundle is turned into a script inside the renderer. Evaluating
 * the URL is the platform's call, because the page's policy is the client's.
 */
export async function importBundle(bundle: DesktopExtensionBundle, platform: Platform = getPlatform()): Promise<unknown> {
  if (bundle.url) return platform.importModule(bundle.url);
  const url = URL.createObjectURL(new Blob([bundle.code], { type: "text/javascript" }));
  try {
    return await platform.importModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Loads desktop extensions from disk into the registry, the way Pi loads its
 * own extensions from `.pi/extensions`. Each sync replaces what an earlier sync
 * activated, so a workspace switch swaps the project-level set and a reload
 * picks up edited files.
 */
export class RuntimeExtensions {
  private loaded: RuntimeExtensionRecord[] = [];
  private generation = 0;
  private cwd?: string;

  constructor(private readonly registry: ExtensionRegistry, private readonly host: RuntimeExtensionHost) {
    // Until the first load has run, a page a package brings is still on its way.
    registry.setLoadingExtensions(true);
  }

  list(): readonly RuntimeExtensionRecord[] {
    return this.loaded;
  }

  /**
   * Loads the same workspace again, for a host that reports its package set
   * moved: an approval, an install, an update or a removal. Before the first
   * sync there is no workspace to load, and this does nothing. `only` names the
   * extensions that moved — a watched file edit knows them — and then nothing
   * else is rebuilt, re-imported or re-activated.
   */
  async resync(only?: readonly string[], report: PackagesChangeReport = {}): Promise<readonly RuntimeExtensionRecord[]> {
    for (const failure of report.buildErrors ?? []) this.reportBuildFailure(failure, "host-extension.build.failed");
    for (const waiting of report.awaitingApproval ?? []) this.announceWaiting(waiting.id, waiting.name);
    if (this.cwd === undefined) return this.loaded;
    return only && only.length > 0 ? this.replace(this.cwd, only) : this.sync(this.cwd);
  }

  /**
   * Swaps the modules of the named extensions and leaves every other one
   * running. A replaced extension is a new module, so its panels remount and
   * whatever state they held is gone; a package whose new code does not build
   * keeps the version that does, and says why.
   */
  private async replace(cwd: string, only: readonly string[]): Promise<readonly RuntimeExtensionRecord[]> {
    const generation = this.generation;
    await loadTauApi();
    const result = await this.host.load(cwd, sharedExportNames(), only);
    if (generation !== this.generation) return this.loaded;
    if (result.bundles.length > 0) {
      await loadSharedIcons();
      if (generation !== this.generation) return this.loaded;
    }
    for (const failure of result.errors) {
      this.registry.noteLoadFailure(failure.path, failure.message);
      this.reportBuildFailure(failure, "desktop-extension.failed");
    }
    for (const id of only) {
      const bundle = result.bundles.find((candidate) => candidate.id === id);
      // Matched by the bundle's id — the manifest's, or the one a loose file's
      // path gives it — because that is what the host names. A module may
      // declare a different id of its own (`example.hello` in a file called
      // `hello-panel.tsx`), and then the two never meet.
      const previous = this.loaded.find((record) => record.bundle.id === id);
      // Nothing built for an id the host still knows: either it left the disk,
      // or its files no longer compile and the errors above said so. Either way
      // the half that is running stays the last one that worked.
      if (!bundle) continue;
      try {
        // The old extension is taken down only once the new module is in hand,
        // so its panel is gone for a render rather than for a fetch — the dock
        // keeps the panel the user had open.
        const record = await this.activateBundle(
          bundle,
          this.loaded.filter((entry) => entry !== previous),
          () => generation === this.generation,
          previous ? () => this.registry.deactivate(previous.extension.id) : undefined,
        );
        if (!record) return this.loaded;
        this.loaded = previous
          ? this.loaded.map((entry) => entry === previous ? record : entry)
          : [...this.loaded, record];
        // A changed permission list or isolation sends a package back to waiting: nothing reloaded.
        if (bundle.granted === false) this.announceWaiting(id, record.extension.name);
        else this.host.notify(`Reloaded ${record.extension.name}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.registry.noteLoadFailure(bundle.path, message);
        this.host.log("desktop-extension.failed", `${bundle.path}: ${message}`);
        this.host.notify(`Desktop extension ${bundle.path.split("/").pop()}: ${message.split("\n")[0]}`);
      }
    }
    return this.loaded;
  }

  /**
   * Imports one bundle, checks it is an extension and activates it. Undefined
   * means the load it belongs to was superseded while the module was fetched,
   * so nothing was activated.
   */
  private async activateBundle(
    bundle: DesktopExtensionBundle,
    others: readonly RuntimeExtensionRecord[],
    stillCurrent: () => boolean,
    beforeActivate?: () => void,
    imported: Promise<unknown> = this.importModule(bundle),
  ): Promise<RuntimeExtensionRecord | undefined> {
    const module = await imported;
    if (!stillCurrent()) return undefined;
    const extension = (module as { default?: unknown } | null)?.default;
    if (!isDesktopExtension(extension)) {
      throw new Error("the module's default export is not a desktop extension ({ id, name, activate })");
    }
    if (others.some((entry) => entry.extension.id === extension.id)) {
      throw new Error(`extension id ${extension.id} is already taken by another loaded extension`);
    }
    extension.permissions = bundle.permissions;
    extension.granted = bundle.granted;
    // The stylesheet travels with the extension object, so switching the
    // extension off in Settings takes its rules with it and back on brings
    // them again — the registry owns both ends (see `activate`).
    if (bundle.stylesUrl) extension.styles = { url: bundle.stylesUrl };
    else if (bundle.styles) extension.styles = { css: bundle.styles };
    beforeActivate?.();
    this.registry.addKnown(extension);
    if (bundle.granted !== false && this.host.isEnabled(extension.id)) this.registry.activate(extension);
    this.registry.noteLoadFailure(bundle.path, undefined);
    this.host.log("desktop-extension.loaded", `${extension.name} · ${bundle.scope} · ${bundle.path}`);
    return { extension, bundle };
  }

  /**
   * A package entry that did not compile: the whole message in the log, and a
   * toast with the first error's file, line and column. The version that was
   * running stays, so the toast says so rather than asking for anything.
   */
  private reportBuildFailure(failure: PackageBuildError, label: string): void {
    this.host.log(label, `${failure.path}: ${failure.message}`);
    const first = failure.diagnostics?.[0];
    const more = (failure.diagnostics?.length ?? 0) - 1;
    const line = first ? `${diagnosticLine(first)}${more > 0 ? ` (and ${more} more)` : ""}` : failure.message.split("\n")[0] ?? failure.message;
    if (!this.host.toast) {
      this.host.notify(`${entryLabel(failure.path)} did not build: ${line}`);
      return;
    }
    const openSettings = this.host.openSettings;
    this.host.toast({
      id: `build:${failure.path}`,
      type: "error",
      title: `${entryLabel(failure.path)} did not build`,
      description: `${line}. The version that was running stays.`,
      timeoutMs: 15_000,
      copyText: failure.message,
      ...(openSettings ? { actions: [{ label: "Details", run: () => openSettings("inspector") }] } : {}),
    });
  }

  /** A package whose permissions changed runs no more until the user allows them again. */
  private announceWaiting(id: string, name: string): void {
    this.host.log("extension.awaiting-approval", id);
    if (!this.host.toast) {
      this.host.notify(`${name} is waiting for approval in Settings → Extensions`);
      return;
    }
    const openSettings = this.host.openSettings;
    this.host.toast({
      id: `approval:${id}`,
      type: "warning",
      title: `${name} is waiting for approval`,
      description: "What it asks for changed, so it is off until you allow it again in Settings → Extensions.",
      timeoutMs: 15_000,
      ...(openSettings ? { actions: [{ label: "Review", run: () => openSettings(`extensions/${id}`) }] } : {}),
    });
  }

  private importModule(bundle: DesktopExtensionBundle): Promise<unknown> {
    return (this.host.importModule ?? importBundle)(bundle);
  }

  async sync(cwd: string): Promise<readonly RuntimeExtensionRecord[]> {
    const generation = ++this.generation;
    try {
      return await this.load(cwd, generation);
    } finally {
      if (generation === this.generation) this.registry.setLoadingExtensions(false);
    }
  }

  private async load(cwd: string, generation: number): Promise<readonly RuntimeExtensionRecord[]> {
    this.cwd = cwd;
    await loadTauApi();
    const result = await this.host.load(cwd, sharedExportNames());
    if (generation !== this.generation) return this.loaded;
    // Only a workspace with packages pays for the icon set; it must be in
    // place before a bundle's shim reads its named exports.
    if (result.bundles.length > 0) {
      await loadSharedIcons();
      if (generation !== this.generation) return this.loaded;
    }
    for (const failure of result.errors) {
      this.registry.noteLoadFailure(failure.path, failure.message);
      this.reportBuildFailure(failure, "desktop-extension.failed");
    }
    for (const skip of result.skipped) this.host.log("desktop-extension.skipped", `${skip.directory}: ${skip.reason}`);

    for (const record of this.loaded) {
      try { this.registry.deactivate(record.extension.id); } catch (error) { this.host.log("desktop-extension.deactivate.failed", String(error)); }
    }
    const next: RuntimeExtensionRecord[] = [];
    this.loaded = next;
    // A theme is only a stylesheet, and a stylesheet's rules are ordered by
    // where its <link> lands: last, so a theme's tokens beat core's and every
    // kit's without any of them raising their specificity.
    const ordered = [...result.bundles].sort((left, right) => Number(left.theme ?? false) - Number(right.theme ?? false));
    // Fetched and compiled side by side, activated one after another in this order.
    const imports = ordered.map((bundle) => {
      const imported = this.importModule(bundle);
      imported.catch(() => undefined);
      return imported;
    });
    for (const [index, bundle] of ordered.entries()) {
      try {
        const record = await this.activateBundle(bundle, next, () => generation === this.generation, undefined, imports[index]);
        if (!record) return this.loaded;
        next.push(record);
      } catch (error) {
        if (generation !== this.generation) return this.loaded;
        const message = error instanceof Error ? error.message : String(error);
        this.registry.noteLoadFailure(bundle.path, message);
        this.host.log("desktop-extension.failed", `${bundle.path}: ${message}`);
        this.host.notify(`Desktop extension ${bundle.path.split("/").pop()}: ${message.split("\n")[0]}`);
      }
    }
    return this.loaded;
  }
}
