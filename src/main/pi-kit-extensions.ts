import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * A kit's half inside a Pi runtime Tau does not own.
 *
 * When Tau owns the runtime, a kit adds its Pi extension in-process through
 * `HostExtensionServices.registerRuntimeExtension`. An attached Pi TUI is a
 * different process: it loads Tau's bridge (`.pi/extensions/tau-session-bridge.ts`)
 * under jiti, where no `tau/*` specifier resolves. So a kit ships its Pi half
 * prebuilt as `dist-kits/<id>/pi.cjs` and the bridge requires it — no kit
 * source is ever read by jiti (ADR 0014).
 */
export type PiKitExtension = (pi: ExtensionAPI, bridge: PiKitBridge) => void;

/** A user turn the bridge accepted from Tau, before Pi dispatched it. */
export interface PiKitTurnObserver {
  /** The turn was handed to Pi under this id. */
  accepted(turnId: string, ctx: ExtensionContext): void;
  /** Pi refused the prompt, so the turn will never run. */
  failed(turnId: string, ctx: ExtensionContext): void;
}

/** A transcript message as the bridge projects it: skill wrappers resolved to their visible text. */
export interface PiKitTranscriptMessage {
  role: "user" | "assistant";
  content: unknown;
}

/** A persisted Pi session the bridge opened on a kit's behalf. */
export interface PiKitSession {
  sessionId: string;
  cwd: string;
  entries: readonly unknown[];
}

/**
 * What the bridge lends a kit's Pi half. Everything here is keyed by the kit's
 * own extension id, so a kit can neither read another kit's commands nor
 * publish under its name.
 */
export interface PiKitBridge {
  /** The kit's extension id, as Tau routes its commands and events. */
  readonly extensionId: string;
  /** Answers `<id>/<name>`, which the kit's host half calls through the attached runtime. */
  registerCommand(name: string, handler: (ctx: ExtensionContext, input: Record<string, unknown>) => Promise<unknown>): void;
  /** Publishes an extension event to every attached Tau client. */
  publishEvent(name: string, payload: unknown, ctx: ExtensionContext): void;
  /** Re-sends the snapshot, for a kit whose new session entry changes what the transcript shows. */
  refreshSnapshot(ctx: ExtensionContext): void;
  /** Session entries the transcript must keep even when their message renders empty. */
  pinEntries(pin: (ctx: ExtensionContext) => readonly string[]): void;
  observeUserTurns(observer: PiKitTurnObserver): void;
  /** The branch as Tau shows it; the skill projection is core's. */
  transcript(ctx: ExtensionContext): PiKitTranscriptMessage[];
  /** Reads another persisted session, e.g. the source of a fork. */
  openSession(file: string): PiKitSession | undefined;
  /** Whether this context is still the session the bridge serves. */
  isCurrentSession(ctx: ExtensionContext): boolean;
}

export interface LoadedPiKitExtension {
  id: string;
  file: string;
  extension: PiKitExtension;
}

export interface PiKitExtensionFailure {
  path: string;
  message: string;
}

/** Where the bridge looks for prebuilt kits: `TAU_KITS_DIR`, else `dist-kits/` beside the checkout. */
export function piKitsRoot(bridgeFile: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.TAU_KITS_DIR;
  if (configured) return isAbsolute(configured) ? configured : resolve(configured);
  // `<root>/.pi/extensions/tau-session-bridge.ts` -> `<root>/dist-kits`.
  const candidate = resolve(dirname(bridgeFile), "..", "..", "dist-kits");
  return existsSync(candidate) ? candidate : undefined;
}

const requireModule = createRequire(import.meta.url);

/**
 * The Pi halves of the prebuilt kits, in id order. A kit without a `pi` entry
 * has nothing to run inside the runtime and is skipped silently; a kit whose
 * entry fails to load is reported, because its feature will be missing.
 */
export function loadPiKitExtensions(
  root: string | undefined,
  load: (file: string) => unknown = (file) => requireModule(file),
): { extensions: LoadedPiKitExtension[]; errors: PiKitExtensionFailure[] } {
  const extensions: LoadedPiKitExtension[] = [];
  const errors: PiKitExtensionFailure[] = [];
  if (!root) return { extensions, errors };
  let names: string[];
  try { names = readdirSync(root); } catch { return { extensions, errors }; }
  for (const name of names.sort()) {
    const manifestPath = join(root, name, "tau-extension.json");
    let manifest: { id?: unknown; pi?: unknown };
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id?: unknown; pi?: unknown }; }
    catch { continue; }
    if (typeof manifest.id !== "string" || typeof manifest.pi !== "string") continue;
    const file = join(root, name, manifest.pi);
    try {
      extensions.push({ id: manifest.id, file, extension: piKitExtensionOf(load(file)) });
    } catch (error) {
      errors.push({ path: file, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { extensions, errors };
}

function piKitExtensionOf(module: unknown): PiKitExtension {
  const candidate = (module as { default?: unknown } | null)?.default ?? module;
  if (typeof candidate !== "function") throw new Error("the module must default-export (pi, bridge) => void");
  return candidate as PiKitExtension;
}
