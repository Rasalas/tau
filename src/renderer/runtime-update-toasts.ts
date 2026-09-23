import type { RuntimeToolVersion, UiRuntimeBackend } from "../shared/contracts";
import { compareVersions, updateAvailable } from "../shared/runtime-version";
import type { ClientStorage } from "../workbench/client-storage";
import { getClientStorage } from "../workbench/client-storage";
import type { ToastOptions } from "../workbench/toast-store";
import type { WorkbenchActions } from "./extension-system";

/** Versions this client was told about and dismissed, as `kind@version`. */
export const DISMISSED_UPDATES_KEY = "tau.runtime-updates.dismissed.v1";
/** Kept so the list cannot grow without bound; the oldest go first. */
const DISMISSED_LIMIT = 50;

/** How a command the user asked for ended; no `exitCode` when its shell went away first. */
export interface RuntimeUpdateRun {
  exitCode?: number;
}

export interface RuntimeUpdateToastsOptions {
  /** Runs `command` where the user sees its output; a rejection is the toast's error. */
  run(command: string, backend: UiRuntimeBackend, actions: WorkbenchActions): Promise<RuntimeUpdateRun>;
  /** Whether `run` can, now (a terminal is there); without, the toast only offers the Providers card. */
  canRun?(): boolean;
  /** Asks the backend's version again, once the command ended with 0. */
  recheck(backend: UiRuntimeBackend): Promise<RuntimeToolVersion | undefined>;
  /** The Settings page of the backend's Providers card. */
  settingsPage(backend: UiRuntimeBackend): string;
  /** The client's own storage; the ambient one by default. */
  storage?: ClientStorage;
}

export interface RuntimeUpdateToasts {
  /** Offers each update not offered in this window and not dismissed on this client; call on every catalog. */
  sync(backends: readonly UiRuntimeBackend[], actions: WorkbenchActions): void;
}

/** Keys offered in this window, across every kit that uses these toasts. */
const offered = new Set<string>();

function formatVersion(version: string): string {
  return /^\d/u.test(version) ? `v${version}` : version;
}

function readDismissed(storage: ClientStorage | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.get(DISMISSED_UPDATES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

/** A newer release to offer: the installed one is known, older, and not one the policy warns about (its banner says so). */
export function offerableUpdate(backend: UiRuntimeBackend): (RuntimeToolVersion & { installed: string; latest: string }) | undefined {
  const version = backend.version;
  if (!updateAvailable(version)) return undefined;
  if (version.compatibility && version.compatibility.status !== "supported") return undefined;
  return version;
}

/**
 * T3 Code's provider update notification: one toast per new release of each
 * backend's program, with Update (runs the update command in a terminal the
 * user sees, then asks the version again) and Settings. Nothing is installed
 * without the click; closing the toast remembers that release on this client.
 */
export function createRuntimeUpdateToasts(options: RuntimeUpdateToastsOptions): RuntimeUpdateToasts {
  const storage = () => options.storage ?? getClientStorage();
  const updating = new Set<string>();

  const dismiss = (key: string) => {
    const store = storage();
    const kept = readDismissed(store).filter((entry) => entry !== key);
    store?.set(DISMISSED_UPDATES_KEY, JSON.stringify([...kept, key].slice(-DISMISSED_LIMIT)));
  };

  const update = async (backend: UiRuntimeBackend, version: RuntimeToolVersion & { latest: string }, command: string, actions: WorkbenchActions, id: string) => {
    const show = (toast: Omit<ToastOptions, "id">) => actions.toast?.({ ...toast, id });
    const settings = { label: "Settings", run: () => actions.openSettings(options.settingsPage(backend)) };
    const label = backend.label;
    updating.add(backend.kind);
    try {
      show({ type: "loading", title: `Updating ${label}`, description: `Running ${command} in a terminal.`, timeoutMs: 0 });
      const ran = await options.run(command, backend, actions).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
      if (ran instanceof Error) {
        show({ type: "error", title: `${label} update failed`, description: ran.message, timeoutMs: 0, copyText: command, actions: [settings] });
        return;
      }
      if (ran.exitCode === undefined) {
        show({ type: "warning", title: `${label} update stopped`, description: "The terminal closed before the command finished.", copyText: command, actions: [settings] });
        return;
      }
      if (ran.exitCode !== 0) {
        show({ type: "error", title: `${label} ${formatVersion(version.latest)} update failed`, description: `${command} exited with ${ran.exitCode}; its output is in the terminal.`, timeoutMs: 0, copyText: command, actions: [settings] });
        return;
      }
      const now = await options.recheck(backend).catch(() => undefined);
      if (now?.installed && compareVersions(now.installed, version.latest) >= 0) {
        show({ type: "success", title: `${label} updated: ${formatVersion(now.installed)}`, description: "New threads use the updated version." });
        return;
      }
      show({
        type: "warning",
        title: `${label} still needs an update`,
        description: `${label} still reports ${now?.installed ? formatVersion(now.installed) : "an older version"}. Check provider settings for details.`,
        timeoutMs: 0,
        actions: [settings],
      });
    } finally {
      updating.delete(backend.kind);
    }
  };

  const offer = (backend: UiRuntimeBackend, version: RuntimeToolVersion & { latest: string }, key: string, actions: WorkbenchActions) => {
    const id = `runtime-update:${backend.kind}`;
    const command = (options.canRun?.() ?? true) ? version.updateCommand : undefined;
    // An action clicked closes the toast too; only the close button remembers the release.
    let acted = false;
    const settings = { label: "Settings", run: () => { acted = true; actions.openSettings(options.settingsPage(backend)); } };
    actions.toast?.({
      id,
      type: "warning",
      title: `Update available: ${backend.label} ${formatVersion(version.latest)}`,
      description: command ? "Install the update now or review provider settings." : `${backend.label} can be updated from provider settings.`,
      timeoutMs: 0,
      actions: command
        ? [settings, { label: "Update", keepOpen: true, run: () => { acted = true; void update(backend, version, command, actions, id); } }]
        : [settings],
      onClose: () => { if (!acted) dismiss(key); },
    });
  };

  return {
    sync(backends, actions) {
      if (!actions.toast) return;
      const dismissed = new Set(readDismissed(storage()));
      for (const backend of backends) {
        const version = offerableUpdate(backend);
        if (!version || updating.has(backend.kind)) continue;
        const key = `${backend.kind}@${version.latest}`;
        if (offered.has(key) || dismissed.has(key)) continue;
        offered.add(key);
        offer(backend, version, key, actions);
      }
    },
  };
}

/** Forgets what this window offered; for tests. */
export function resetOfferedUpdates(): void {
  offered.clear();
}
