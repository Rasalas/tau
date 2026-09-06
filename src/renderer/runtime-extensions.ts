import * as React from "react";
import * as ReactDom from "react-dom";
import * as JsxRuntime from "react/jsx-runtime";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult } from "../shared/contracts";
import type { DesktopExtension, ExtensionRegistry } from "./extension-system";
import * as tauApi from "./extension-api";

/** Modules an extension may import by bare name; each resolves to the renderer's own copy. */
export const SHARED_MODULES: Record<string, object> = {
  react: React,
  // `flushSync` and `createPortal` reach into the running root; a second copy
  // of react-dom holds its own internals and silently does nothing.
  "react-dom": ReactDom,
  "react/jsx-runtime": JsxRuntime,
  tau: tauApi,
};

/**
 * The icon set is the one shared module the workbench itself barely uses; a
 * namespace import would put every icon into the initial bundle. It is
 * fetched as its own chunk the first time a package actually needs it.
 */
let iconModule: Promise<object> | undefined;
export function loadSharedIcons(): Promise<object> {
  iconModule ??= import("lucide-react").then((module) => {
    SHARED_MODULES["lucide-react"] = module;
    return module;
  });
  return iconModule;
}

export function sharedExportNames(modules: Record<string, object> = SHARED_MODULES): Record<string, string[]> {
  const names = Object.fromEntries(Object.entries(modules).map(([name, module]) => [name, Object.keys(module)]));
  // Still a shared specifier before the icon set is loaded; the host fills in
  // the export names from its own copy when the list is empty.
  if (modules === SHARED_MODULES && !("lucide-react" in names)) names["lucide-react"] = [];
  return names;
}

export function installSharedModules(target: { __tauShared?: Record<string, object> } = globalThis as never): void {
  // oxlint-disable-next-line eslint/no-underscore-dangle -- __tauShared is a cross-file global protocol name (see extension-api.ts, desktop-extensions.ts).
  target.__tauShared = SHARED_MODULES;
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
  load(cwd: string, sharedExports: Record<string, string[]>): Promise<DesktopExtensionLoadResult>;
  /** Evaluates a bundle as an ES module; defaults to the host's `tau-ext:` URL. */
  importModule?(bundle: DesktopExtensionBundle): Promise<unknown>;
  isEnabled(id: string): boolean;
  notify(message: string): void;
  log(label: string, detail?: string): void;
}

/**
 * The desktop host serves every bundle under `tau-ext:`, which is what the CSP
 * allows. The browser preview has no host, so it falls back to a blob URL — the
 * one place a bundle is turned into a script inside the renderer.
 */
export async function importBundle(bundle: DesktopExtensionBundle): Promise<unknown> {
  if (bundle.url) return import(/* @vite-ignore */ bundle.url);
  const url = URL.createObjectURL(new Blob([bundle.code], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ url);
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

  constructor(private readonly registry: ExtensionRegistry, private readonly host: RuntimeExtensionHost) {}

  list(): readonly RuntimeExtensionRecord[] {
    return this.loaded;
  }

  /**
   * Loads the same workspace again, for a host that reports its package set
   * moved: an approval, an install, an update or a removal. Before the first
   * sync there is no workspace to load, and this does nothing.
   */
  async resync(): Promise<readonly RuntimeExtensionRecord[]> {
    return this.cwd === undefined ? this.loaded : this.sync(this.cwd);
  }

  async sync(cwd: string): Promise<readonly RuntimeExtensionRecord[]> {
    this.cwd = cwd;
    const generation = ++this.generation;
    const result = await this.host.load(cwd, sharedExportNames());
    if (generation !== this.generation) return this.loaded;
    // Only a workspace with packages pays for the icon set; it must be in
    // place before a bundle's shim reads its named exports.
    if (result.bundles.length > 0) {
      await loadSharedIcons();
      if (generation !== this.generation) return this.loaded;
    }
    for (const failure of result.errors) {
      this.host.log("desktop-extension.failed", `${failure.path}: ${failure.message}`);
      this.host.notify(`Desktop extension failed to build: ${failure.message.split("\n")[0]}`);
    }
    for (const skip of result.skipped) this.host.log("desktop-extension.skipped", `${skip.directory}: ${skip.reason}`);

    for (const record of this.loaded) {
      try { this.registry.deactivate(record.extension.id); } catch (error) { this.host.log("desktop-extension.deactivate.failed", String(error)); }
    }
    const next: RuntimeExtensionRecord[] = [];
    for (const bundle of result.bundles) {
      try {
        const module = await (this.host.importModule ?? importBundle)(bundle);
        const extension = (module as { default?: unknown } | null)?.default;
        if (!isDesktopExtension(extension)) {
          throw new Error("the module's default export is not a desktop extension ({ id, name, activate })");
        }
        if (next.some((entry) => entry.extension.id === extension.id)) {
          throw new Error(`extension id ${extension.id} is already taken by another loaded extension`);
        }
        extension.permissions = bundle.permissions;
        extension.granted = bundle.granted;
        // The stylesheet travels with the extension object, so switching the
        // extension off in Settings takes its rules with it and back on brings
        // them again — the registry owns both ends (see `activate`).
        if (bundle.stylesUrl) extension.styles = { url: bundle.stylesUrl };
        else if (bundle.styles) extension.styles = { css: bundle.styles };
        this.registry.addKnown(extension);
        if (bundle.granted !== false && this.host.isEnabled(extension.id)) this.registry.activate(extension);
        next.push({ extension, bundle });
        this.host.log("desktop-extension.loaded", `${extension.name} · ${bundle.scope} · ${bundle.path}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.host.log("desktop-extension.failed", `${bundle.path}: ${message}`);
        this.host.notify(`Desktop extension ${bundle.path.split("/").pop()}: ${message.split("\n")[0]}`);
      }
    }
    this.loaded = next;
    return next;
  }
}
