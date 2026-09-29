import type { RuntimeToolVersion, UiRuntimeBackend } from "../shared/contracts";
import { compareVersions, updateAvailable } from "../shared/runtime-version";
import type { ClientStorage } from "../workbench/client-storage";
import { getClientStorage } from "../workbench/client-storage";
import { errorMessage } from "../workbench/error-message";
import { getHostClient } from "./host-client-context";
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
  /** Redraws the offers still on screen once `canRun` changed, so a terminal that came late adds Update. */
  refresh(): void;
}

/** Keys offered in this window, across every kit that uses these toasts. */
const offered = new Set<string>();
/** "Keep agent tools up to date?" is asked once per window, whichever kit's update came first; `open` while on screen. */
let question: "open" | "closed" | undefined;

/**
 * The one question before the first update Tau could run itself: keep the
 * agent CLIs current on this machine, or leave them to the user. Answered,
 * the host stops asking; unanswered, each release is offered as before.
 */
function askAutomatic(backends: readonly UiRuntimeBackend[], actions: WorkbenchActions, unanswered: () => void): boolean {
  const client = getHostClient();
  const asking = backends.filter((backend) => backend.version?.updates === "ask" && updateAvailable(backend.version));
  if (question || asking.length === 0 || !client?.runtimeTools || client.isOwner?.() === false || !actions.toast) return false;
  question = "open";
  let answered = false;
  const answer = (on: boolean) => {
    answered = true;
    client.runtimeTools!("automatic", { on }).then(
      () => actions.notify(on ? "Tau keeps the agent tools up to date." : "Tau leaves updating the agent tools to you."),
      (error: unknown) => actions.toast?.({ type: "error", title: "Could not save the choice", description: errorMessage(error) }),
    );
  };
  const names = asking.map((backend) => backend.label).join(", ");
  actions.toast({
    id: "runtime-tools:ask",
    type: "info",
    title: "Keep agent tools up to date?",
    description: `An update of ${names} is out. Tau can install such updates itself while none of their turns runs; Settings → Runtimes shows each one.`,
    timeoutMs: 0,
    actions: [{ label: "Not now", run: () => answer(false) }, { label: "Keep up to date", run: () => answer(true) }],
    // Closed without an answer: the releases are offered one by one, and the next window asks again.
    onClose: () => {
      question = "closed";
      if (!answered) unanswered();
    },
  });
  return true;
}

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
  // Tau updates this one itself (Settings → Runtimes).
  if (!updateAvailable(version) || version.updates === "automatic") return undefined;
  if (version.compatibility && version.compatibility.status !== "supported") return undefined;
  return version;
}

/**
 * The runtime update notification: one toast per new release of each
 * backend's program, with Update (runs the update command in a terminal the
 * user sees, then asks the version again) and Settings. Nothing is installed
 * without the click; closing the toast remembers that release on this client.
 */
export function createRuntimeUpdateToasts(options: RuntimeUpdateToastsOptions): RuntimeUpdateToasts {
  const storage = () => options.storage ?? getClientStorage();
  const updating = new Set<string>();
  /** Offers still on screen, by kind: whether they carry Update, and how to draw them again. */
  const open = new Map<string, { runnable: boolean; redraw(): void }>();
  const runnable = () => options.canRun?.() ?? true;

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
    const can = runnable();
    const command = can ? version.updateCommand : undefined;
    // An action clicked closes the toast too; only the close button remembers the release.
    let acted = false;
    const settle = () => { acted = true; open.delete(backend.kind); };
    const settings = { label: "Settings", run: () => { settle(); actions.openSettings(options.settingsPage(backend)); } };
    open.set(backend.kind, { runnable: can, redraw: () => offer(backend, version, key, actions) });
    actions.toast?.({
      id,
      type: "warning",
      title: `Update available: ${backend.label} ${formatVersion(version.latest)}`,
      description: command ? "Install the update now or review provider settings." : `${backend.label} can be updated from provider settings.`,
      timeoutMs: 0,
      actions: command
        ? [settings, { label: "Update", keepOpen: true, run: () => { settle(); void update(backend, version, command, actions, id); } }]
        : [settings],
      onClose: () => { if (acted) return; open.delete(backend.kind); dismiss(key); },
    });
  };

  const offerAll = (backends: readonly UiRuntimeBackend[], actions: WorkbenchActions) => {
    const dismissed = new Set(readDismissed(storage()));
    for (const backend of backends) {
      const version = offerableUpdate(backend);
      if (!version || updating.has(backend.kind)) continue;
      const key = `${backend.kind}@${version.latest}`;
      if (offered.has(key) || dismissed.has(key)) continue;
      offered.add(key);
      offer(backend, version, key, actions);
    }
  };

  return {
    refresh() {
      const now = runnable();
      for (const prompt of [...open.values()]) if (prompt.runnable !== now) prompt.redraw();
    },
    sync(backends, actions) {
      if (!actions.toast) return;
      if (askAutomatic(backends, actions, () => offerAll(backends, actions))) return;
      // While the question is open, a release it covers is not offered beside it.
      offerAll(question === "open" ? backends.filter((backend) => backend.version?.updates !== "ask") : backends, actions);
    },
  };
}

/** Forgets what this window offered; for tests. */
export function resetOfferedUpdates(): void {
  offered.clear();
  question = undefined;
}
