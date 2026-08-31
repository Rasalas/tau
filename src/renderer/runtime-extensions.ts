import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as Lucide from "lucide-react";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult } from "../shared/contracts";
import type { DesktopExtension, ExtensionRegistry } from "./extension-system";
import * as tauApi from "./extension-api";

/** Modules an extension may import by bare name; each resolves to the renderer's own copy. */
export const SHARED_MODULES: Record<string, object> = {
  react: React,
  "react/jsx-runtime": JsxRuntime,
  "lucide-react": Lucide,
  tau: tauApi,
};

export function sharedExportNames(modules: Record<string, object> = SHARED_MODULES): Record<string, string[]> {
  return Object.fromEntries(Object.entries(modules).map(([name, module]) => [name, Object.keys(module)]));
}

export function installSharedModules(target: { __tauShared?: Record<string, object> } = globalThis as never): void {
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
  /** Evaluates a bundle as an ES module; defaults to a blob URL import. */
  importModule?(code: string, path: string): Promise<unknown>;
  isEnabled(id: string): boolean;
  notify(message: string): void;
  log(label: string, detail?: string): void;
}

async function importFromBlob(code: string): Promise<unknown> {
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
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

  constructor(private readonly registry: ExtensionRegistry, private readonly host: RuntimeExtensionHost) {}

  list(): readonly RuntimeExtensionRecord[] {
    return this.loaded;
  }

  async sync(cwd: string): Promise<readonly RuntimeExtensionRecord[]> {
    const generation = ++this.generation;
    const result = await this.host.load(cwd, sharedExportNames());
    if (generation !== this.generation) return this.loaded;
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
        const module = await (this.host.importModule ?? ((code) => importFromBlob(code)))(bundle.code, bundle.path);
        const extension = (module as { default?: unknown } | null)?.default;
        if (!isDesktopExtension(extension)) {
          throw new Error("the module's default export is not a desktop extension ({ id, name, activate })");
        }
        if (next.some((entry) => entry.extension.id === extension.id)) {
          throw new Error(`extension id ${extension.id} is already taken by another loaded extension`);
        }
        this.registry.addKnown(extension);
        if (this.host.isEnabled(extension.id)) this.registry.activate(extension);
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
