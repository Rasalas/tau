import * as React from "react";
import * as ReactDom from "react-dom";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactVirtual from "@tanstack/react-virtual";
import { errorMessage } from "../workbench/error-message";
import type { DesktopExtensionBundle, DesktopExtensionLoadResult, PackageBuildError } from "../shared/contracts";
import type { PackagesChangeReport } from "../workbench/host-events";
import { diagnosticLine } from "../shared/build-diagnostics";
import { DESKTOP_BUNDLE_REJECTION_MESSAGES } from "../shared/trusted-desktop-bundles";
import { EXTENSION_API_VERSION, satisfiesRange } from "../shared/extension-compat";
import type { ClientStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";
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
  notify(message: string, level?: "info" | "warning" | "error"): void;
  /** A toast with a type, lines and actions. */
  toast(options: ToastOptions): void;
  /** This machine's store, for the notices the user closed; without one a closed notice stays closed for this run only. */
  storage?: ClientStorage;
  /** Opens a place in Settings, for a toast's action. */
  openSettings(target: string): void;
  log(label: string, detail?: string): void;
}

/** The entry's folder and file, which is what an author recognises: `my-kit/desktop.tsx`. */
function entryLabel(path: string): string {
  return path.split(/[\\/]/u).slice(-2).join("/");
}

type Unavailability = keyof typeof DESKTOP_BUNDLE_REJECTION_MESSAGES;

interface UnavailableExtension {
  id: string;
  name: string;
  reason: Unavailability;
}

const UNAVAILABLE_TOAST_ID = "extensions-unavailable";
const UNAVAILABLE_NAMES_SHOWN = 3;
const UNAVAILABLE_REMEMBERED = 100;
const ACRONYMS = new Set(["ai", "api", "css", "html", "ui", "url"]);

/** Why a client turned an extension away, or undefined for any other load error. */
function unavailability(message: string): Unavailability | undefined {
  return (Object.keys(DESKTOP_BUNDLE_REJECTION_MESSAGES) as Unavailability[]).find((key) => DESKTOP_BUNDLE_REJECTION_MESSAGES[key] === message);
}

/** The package folder (or loose file) an entry belongs to: `tau.terminal` for `…/tau.terminal/desktop.js`. */
function extensionId(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  const file = (parts.pop() ?? "").replace(/\.[^.]+$/u, "");
  return /^(?:desktop|index)$/u.test(file) ? parts.pop() ?? file : file;
}

/** A rejected extension's manifest never reaches this client, so its name is its id in words: `tau.html-pages` is "HTML Pages". */
function extensionName(id: string): string {
  const words = (id.includes(".") ? id.slice(id.indexOf(".") + 1) : id).split(/[-_.\s]+/u).filter(Boolean);
  return words.map((word) => ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1)).join(" ") || id;
}

/** "Terminal", "Terminal and Files", "Terminal, Files, Agents and 2 more". */
function nameList(names: readonly string[]): string {
  const shown = names.slice(0, UNAVAILABLE_NAMES_SHOWN);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0] ?? "";
}

/**
 * The desktop host serves every bundle under `tau-ext:`, which is what the CSP
 * allows. The browser preview has no host, so it falls back to a blob URL — the
 * one place a bundle is turned into a script inside the renderer. Evaluating
 * the URL is the platform's call, because the page's policy is the client's.
 */
export async function importBundle(bundle: DesktopExtensionBundle, platform: Platform = getPlatform()): Promise<unknown> {
  if (bundle.granted === false) throw new Error(`Extension ${bundle.id} is awaiting approval`);
  if (bundle.url) return platform.importModule(bundle.url);
  const url = URL.createObjectURL(new Blob([bundle.code], { type: "text/javascript" }));
  try {
    return await platform.importModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Whether this client's own extension API is older than the bundle needs. The
 * host checks `engines` against its API only, and a phone app can lag the host
 * it talks to; such a bundle stays off here until the app updates.
 */
export function needsNewerClient(bundle: DesktopExtensionBundle, api: string = EXTENSION_API_VERSION): boolean {
  const range = bundle.engines?.api;
  if (!range) return false;
  try {
    return !satisfiesRange(api, range);
  } catch {
    return false;
  }
}

/** Identity includes approval and origin as well as the code and stylesheet. */
function sameBundle(left: DesktopExtensionBundle, right: DesktopExtensionBundle): boolean {
  const identity = (bundle: DesktopExtensionBundle) => [
    bundle.path, bundle.scope, bundle.projectPath, bundle.manifestId,
    bundle.hash ?? bundle.code, bundle.hash ?? bundle.styles,
    bundle.url, bundle.stylesUrl, bundle.permissions, bundle.granted, bundle.theme, bundle.source,
  ];
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

/**
 * Loads desktop extensions from disk into the registry, the way Pi loads its
 * own extensions from `.pi/extensions`. Each sync reconciles the workspace's
 * packages with those already running,
 * so unchanged contributions and styles survive navigation and background scans.
 */
export class RuntimeExtensions {
  private loaded: RuntimeExtensionRecord[] = [];
  private generation = 0;
  private cwd?: string;
  /** Unavailable extensions a notice already named in this run. */
  private readonly announced = new Set<string>();

  constructor(private readonly registry: ExtensionRegistry, private readonly host: RuntimeExtensionHost) {
    // Until the first load has run, a page a package brings is still on its way.
    registry.setLoadingExtensions(true);
  }

  /** Packages the host reported as its own in the report being applied. */
  private ownWaiting = new Set<string>();

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
    this.ownWaiting = new Set((report.awaitingApproval ?? []).filter((waiting) => waiting.own).map((waiting) => waiting.id));
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
    // Every bundle shares the icon namespace. Load it alongside the API and
    // host request instead of adding another network round trip afterwards.
    const icons = loadSharedIcons();
    icons.catch(() => undefined);
    await loadTauApi();
    const result = this.withoutTooNew(await this.host.load(cwd, sharedExportNames(), only));
    if (generation !== this.generation) return this.loaded;
    if (result.bundles.length > 0) {
      await icons;
      if (generation !== this.generation) return this.loaded;
    }
    this.reportLoadErrors(result.errors, result.bundles);
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
      if (bundle.granted === false) {
        if (previous) {
          try { this.registry.deactivate(previous.extension.id); } catch (error) { this.host.log("desktop-extension.deactivate.failed", String(error)); }
        }
        this.loaded = this.loaded.filter((entry) => entry !== previous);
        // A package that never ran has nothing that changed; its install card or Settings says so.
        if (previous) this.announceWaiting(id, previous.extension.name);
        continue;
      }
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
        this.host.notify(`Reloaded ${record.extension.name}`);
      } catch (error) {
        this.reportLoadFailure(bundle, error);
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
    if (bundle.manifestId !== undefined && extension.id !== bundle.manifestId) {
      throw new Error(`extension id ${extension.id} does not match manifest id ${bundle.manifestId}`);
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
   * Drops the bundles this client is too old for, without a notice: the
   * feature just is not here yet. On `replace`, the version already running stays.
   */
  private withoutTooNew(result: DesktopExtensionLoadResult): DesktopExtensionLoadResult {
    const tooNew = result.bundles.filter((bundle) => needsNewerClient(bundle));
    if (tooNew.length === 0) return result;
    for (const bundle of tooNew) {
      this.host.log("desktop-extension.deferred", `${bundle.id} needs extension API ${bundle.engines?.api}, this client has ${EXTENSION_API_VERSION}`);
    }
    return { ...result, bundles: result.bundles.filter((bundle) => !tooNew.includes(bundle)) };
  }

  /** A module that would not load or activate: the record, the log, and its first line as a notice. */
  private reportLoadFailure(bundle: DesktopExtensionBundle, error: unknown): void {
    const message = errorMessage(error);
    this.registry.noteLoadFailure(bundle.path, message);
    this.host.log("desktop-extension.failed", `${bundle.path}: ${message}`);
    this.host.notify(`Desktop extension ${bundle.path.split("/").pop()}: ${message.split("\n")[0]}`, "error");
  }

  /** Entries a load left out: a client's refusals become one notice, a failed build gets its own. */
  private reportLoadErrors(errors: DesktopExtensionLoadResult["errors"], loaded: readonly DesktopExtensionBundle[]): void {
    // One that loads again was fixed; a later mismatch deserves a new notice.
    this.forgetDismissed(loaded.map((bundle) => bundle.id));
    const unavailable = new Map<string, UnavailableExtension>();
    for (const failure of errors) {
      this.registry.noteLoadFailure(failure.path, failure.message);
      const reason = unavailability(failure.message);
      if (!reason) { this.reportBuildFailure(failure, "desktop-extension.failed"); continue; }
      this.host.log("desktop-extension.failed", `${failure.path}: ${failure.message}`);
      const id = extensionId(failure.path);
      unavailable.set(id, { id, name: extensionName(id), reason });
    }
    this.announceUnavailable([...unavailable.values()]);
  }

  /** One notice for all of them. It has no timeout because `onClose` also runs on one: closing it is the dismissal. */
  private announceUnavailable(unavailable: readonly UnavailableExtension[]): void {
    const dismissed = this.dismissedUnavailable();
    const pending = unavailable.filter((entry) => !dismissed.has(entry.id));
    if (pending.every((entry) => this.announced.has(entry.id))) return;
    for (const entry of pending) this.announced.add(entry.id);
    const names = (reason: Unavailability) => nameList(pending.filter((entry) => entry.reason === reason).map((entry) => entry.name));
    const changed = pending.some((entry) => entry.reason === "changed");
    const missing = names("missing");
    const recovery = "Use the same Tau version on this app and the connected machine.";
    this.host.toast({
      id: UNAVAILABLE_TOAST_ID,
      type: "warning",
      title: changed
        ? pending.length === 1 ? "An extension needs an update" : "Extensions need an update"
        : pending.length === 1 ? "An extension wasn't loaded" : "Some extensions weren't loaded",
      description: changed && missing
        ? `${recovery} Not included in this app: ${missing}.`
        : changed ? recovery : `This app does not include ${missing}.`,
      actions: changed ? [{ label: "Open updates", run: () => this.host.openSettings("about#setting-check-for-updates") }] : undefined,
      timeoutMs: 0,
      onClose: () => this.rememberDismissed(pending.map((entry) => entry.id)),
    });
  }

  private dismissedUnavailable(): Set<string> {
    try {
      const parsed: unknown = JSON.parse(this.host.storage?.get(STORAGE_KEYS.unavailableExtensions) ?? "[]");
      return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
    } catch {
      return new Set();
    }
  }

  private forgetDismissed(ids: readonly string[]): void {
    for (const id of ids) this.announced.delete(id);
    const dismissed = this.dismissedUnavailable();
    if (!ids.some((id) => dismissed.has(id))) return;
    for (const id of ids) dismissed.delete(id);
    try { this.host.storage?.set(STORAGE_KEYS.unavailableExtensions, JSON.stringify([...dismissed])); } catch { /* stays quiet for this run */ }
  }

  private rememberDismissed(ids: readonly string[]): void {
    const remembered = [...new Set([...this.dismissedUnavailable(), ...ids])].slice(-UNAVAILABLE_REMEMBERED);
    try { this.host.storage?.set(STORAGE_KEYS.unavailableExtensions, JSON.stringify(remembered)); } catch { /* still announced for this run */ }
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
    this.host.toast({
      id: `build:${failure.path}`,
      type: "error",
      title: `${entryLabel(failure.path)} did not build`,
      description: `${line}. The version that was running stays.`,
      timeoutMs: 15_000,
      copyText: failure.message,
      actions: [{ label: "Details", opens: true, run: () => this.host.openSettings("inspector") }],
    });
  }

  /** A package whose permissions changed runs no more until the user allows them again. */
  private announceWaiting(id: string, name: string): void {
    this.host.log("extension.awaiting-approval", id);
    // A package the host wrote starts again by itself when the thread that builds it installs it at Full access.
    if (this.ownWaiting.has(id)) {
      this.host.toast({
        id: `approval:${id}`,
        type: "info",
        title: `${name} is off`,
        description: "What it asks for changed. It waits for the thread that builds it.",
        timeoutMs: 15_000,
      });
      return;
    }
    this.host.toast({
      id: `approval:${id}`,
      type: "warning",
      title: `${name} is waiting for approval`,
      description: "What it asks for changed, so it is off until you allow it again in Settings → Extensions.",
      timeoutMs: 15_000,
      actions: [{ label: "Review", opens: true, run: () => this.host.openSettings(`extensions/${id}`) }],
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
    const icons = loadSharedIcons();
    icons.catch(() => undefined);
    await loadTauApi();
    const result = this.withoutTooNew(await this.host.load(cwd, sharedExportNames()));
    if (generation !== this.generation) return this.loaded;
    // The namespace must be in place before a bundle reads its named exports.
    if (result.bundles.length > 0) {
      await icons;
      if (generation !== this.generation) return this.loaded;
    }
    this.reportLoadErrors(result.errors, result.bundles);
    for (const skip of result.skipped) this.host.log("desktop-extension.skipped", `${skip.directory}: ${skip.reason}`);

    const retained = this.loaded.filter((record) => result.bundles.some((bundle) =>
      bundle.id === record.bundle.id && sameBundle(bundle, record.bundle)));
    for (const record of this.loaded.filter((entry) => !retained.includes(entry))) {
      try { this.registry.deactivate(record.extension.id); } catch (error) { this.host.log("desktop-extension.deactivate.failed", String(error)); }
    }
    const next: RuntimeExtensionRecord[] = [...retained];
    this.loaded = next;
    // A theme is only a stylesheet, and a stylesheet's rules are ordered by
    // where its <link> lands: last, so a theme's tokens beat core's and every
    // kit's without any of them raising their specificity.
    const ordered = [...result.bundles].sort((left, right) => Number(left.theme ?? false) - Number(right.theme ?? false));
    // Fetched and compiled side by side, activated one after another in this order.
    const imports = ordered.map((bundle) => {
      if (bundle.granted === false) return undefined;
      if (retained.some((record) => record.bundle.id === bundle.id)) return undefined;
      const imported = this.importModule(bundle);
      imported.catch(() => undefined);
      return imported;
    });
    for (const [index, bundle] of ordered.entries()) {
      if (bundle.granted === false) continue;
      const existing = retained.find((record) => record.bundle.id === bundle.id);
      if (existing) continue;
      try {
        const record = await this.activateBundle(bundle, next, () => generation === this.generation, undefined, imports[index]);
        if (!record) return this.loaded;
        next.push(record);
      } catch (error) {
        if (generation !== this.generation) return this.loaded;
        this.reportLoadFailure(bundle, error);
      }
    }
    // Newly added kit styles must still precede retained themes. Leave every
    // node alone when their order is already right, as on an unchanged scan.
    const sheets = [...document.head.querySelectorAll<HTMLElement>("[data-tau-extension]")];
    const themes = new Set(next.filter((record) => record.bundle.theme).map((record) => record.extension.id));
    let sawTheme = false;
    const needsOrder = sheets.some((sheet) => {
      if (themes.has(sheet.dataset.tauExtension ?? "")) { sawTheme = true; return false; }
      return sawTheme;
    });
    if (needsOrder) {
      for (const sheet of sheets) {
        if (themes.has(sheet.dataset.tauExtension ?? "")) document.head.append(sheet);
      }
    }
    await this.registry.whenStylesReady();
    return this.loaded;
  }
}
