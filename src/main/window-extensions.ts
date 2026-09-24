import { createRequire } from "node:module";
import { loadDependencyModule } from "./dependency-loader.js";
import type { HostLogger } from "./host-log.js";

const requireModule = createRequire(import.meta.url);

/**
 * Core's own window half: what a host asks of the window for itself rather
 * than for a kit (the folder picker). Not a valid extension id, so no kit can
 * claim it.
 */
export const WINDOW_SERVICES_ID = "window";

/** What a window half may ask of the process it runs in. */
export interface WindowExtensionContext {
  readonly id: string;
  /** Calls a command of this extension's own host half. */
  invokeHost(command: string, input?: unknown): Promise<unknown>;
  log(label: string, detail?: string): void;
  /**
   * A module from Tau's own npm dependencies, resolved in the window's process
   * the way `services.loadDependency` resolves one in the host's: a native addon
   * that must act on this machine (its windows, its accessibility) loads here.
   * Absent before API 1.12.0.
   */
  loadDependency?(packageName: string): Promise<unknown>;
}

/** The window half itself: one command handler and a way to let go. */
export interface WindowExtension {
  handle(command: string, input?: unknown): unknown;
  dispose?(): void;
}

export type WindowExtensionFactory = (context: WindowExtensionContext) => WindowExtension;

export interface WindowExtensionPorts {
  /** Reaches the host half of an extension over this window's own connection. */
  invokeHost(extensionId: string, command: string, input?: unknown): Promise<unknown>;
  logger?: HostLogger;
  /** Stands in for resolving from Tau's own modules, for tests. */
  loadDependency?(packageName: string): Promise<unknown>;
}

/**
 * The halves of the kits that need the window's process rather than the
 * host's: a native view over a panel, for instance, which only the process
 * that owns the window can create. The host reaches them with `callClient`,
 * which arrives as a `client-call` push (ADR 0021).
 */
export class WindowExtensionRegistry {
  private readonly extensions = new Map<string, WindowExtension>();

  constructor(private readonly ports: WindowExtensionPorts) {}

  get ids(): string[] {
    return [...this.extensions.keys()];
  }

  register(id: string, factory: WindowExtensionFactory): void {
    if (this.extensions.has(id)) return;
    this.extensions.set(id, factory({
      id,
      invokeHost: (command, input) => this.ports.invokeHost(id, command, input),
      log: (label, detail) => this.ports.logger?.info(`window-extension.${id}.${label}`, detail),
      loadDependency: (packageName) => (this.ports.loadDependency ?? loadDependencyModule)(packageName),
    }));
  }

  /** Loads compiled window halves; one that will not load leaves the others alone. */
  load(halves: ReadonlyArray<{ id: string; file: string }>): void {
    for (const half of halves) {
      try {
        this.register(half.id, loadWindowExtension(half.file));
      } catch (error) {
        this.ports.logger?.error("window-extension.failed", { id: half.id, error: String(error) });
      }
    }
  }

  async invoke(extensionId: string, command: string, input?: unknown): Promise<unknown> {
    const extension = this.extensions.get(extensionId);
    if (!extension) throw new Error(`This window has no half of ${extensionId}.`);
    return extension.handle(command, input);
  }

  dispose(): void {
    for (const extension of this.extensions.values()) {
      try { extension.dispose?.(); } catch { /* a half that cannot let go must not block the rest */ }
    }
    this.extensions.clear();
  }
}

/** A compiled window half from disk; the module default-exports its factory. */
export function loadWindowExtension(file: string): WindowExtensionFactory {
  const module = requireModule(file) as { default?: unknown; activate?: unknown };
  const factory = module.default ?? module.activate;
  if (typeof factory !== "function") throw new Error(`${file} does not export a window extension factory.`);
  return factory as WindowExtensionFactory;
}
