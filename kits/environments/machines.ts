import type { EnvironmentTarget, HostDisplayKind, HostReadiness, HostResources, RuntimeReadiness, RuntimeReadinessState, UiEnvironment, UiEnvironments, WorkbenchActions } from "tau";

/** `5m`, `3h`, `2d`, then a date: the rail's own spelling. */
export function shortAge(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}

function ago(timestamp: number, now: number): string {
  const age = shortAge(timestamp, now);
  return age === "now" ? "just now" : /\d[mhd]$/u.test(age) ? `${age} ago` : `on ${age}`;
}

/** One line on how the window's connection to a machine is doing; the dot's tooltip and the settings row. */
export function statusText(environment: UiEnvironment, now: number): string {
  switch (environment.status) {
    case "connected":
      return environment.roundTripMs !== undefined ? `Connected · ${environment.roundTripMs} ms` : "Connected";
    case "connecting":
      return "Connecting…";
    case "offline":
      return environment.lastSeenAt !== undefined ? `Offline · last seen ${ago(environment.lastSeenAt, now)}` : "Offline · not reached yet";
    case "refused":
      return `Refused · ${environment.detail ?? "it does not accept this window any more"}`;
  }
}

/** Why a machine's threads cannot be opened now; undefined when they can. */
export function unavailableReason(environment: UiEnvironment, now: number): string | undefined {
  if (environment.status === "connected") return undefined;
  if (environment.status === "refused") return `${environment.name} refuses this window. Remove it in Settings → Machines and add it again.`;
  if (environment.status === "connecting") return `Connecting to ${environment.name}…`;
  return `${environment.name} is offline${environment.lastSeenAt !== undefined ? ` (last seen ${ago(environment.lastSeenAt, now)})` : ""}.`;
}

/** Why a new thread cannot start on a machine; undefined when it can. */
export function cannotStartReason(environment: UiEnvironment, now: number): string | undefined {
  if (environment.readOnly) return `Read only: ${environment.name} lets this computer look, not start threads.`;
  return unavailableReason(environment, now);
}

/** The machines besides the one this page shows, this machine first. */
export function otherMachines(list: UiEnvironments): UiEnvironment[] {
  return list.environments.filter((environment) => environment.id !== list.shown)
    .sort((a, b) => Number(b.local) - Number(a.local) || a.name.localeCompare(b.name));
}

export function shownMachine(list: UiEnvironments): UiEnvironment | undefined {
  return list.environments.find((environment) => environment.id === list.shown);
}

/** `482 913`: easier to compare across two screens. */
export function formatDigits(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export interface ArrivalPorts {
  actions: WorkbenchActions;
  /** Waits between tries while the page is still starting. */
  wait(ms: number): Promise<void>;
  tries?: number;
  /**
   * False once the workbench gave way to an overlay (a first start's setup):
   * the arrival stops and is followed again when the workbench is back.
   */
  shown?(): boolean;
}

/**
 * Opens what the page was sent to this machine for. The page may still be
 * starting, so each step is tried again until the workbench has it.
 */
export async function followArrival(target: EnvironmentTarget, ports: ArrivalPorts): Promise<boolean> {
  // A machine seen for the first time may show its first-start steps before the workbench.
  const tries = ports.tries ?? 480;
  const { actions } = ports;
  const away = () => ports.shown?.() === false;
  if ("thread" in target) {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (away()) return false;
      if (await actions.switchSession(target.thread.path).catch(() => false)) return true;
      await ports.wait(250);
    }
    return false;
  }
  const { draft, workspaceId } = target.newThread;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (away()) return false;
    const active = actions.activeThread();
    if (active?.draftPending && (!workspaceId || active.workspaceId === workspaceId)) {
      // The draft's composer may mount after the draft and restore an empty text; set it until it holds.
      if (!draft || !actions.setComposerDraft || actions.composerDraft() === draft) {
        actions.focusComposer();
        return true;
      }
      actions.setComposerDraft(draft);
      await ports.wait(250);
      continue;
    }
    // Without a project the picker opens, once; with one, the page may not know it yet.
    if (workspaceId) actions.newSession({ workspace: workspaceId });
    else if (attempt === 0) actions.newSession();
    await ports.wait(250);
  }
  return false;
}

/** An arrival not yet placed, kept for the machine it was sent to until the workbench there has it. */
export interface PendingArrival {
  machine: string;
  target: EnvironmentTarget;
}

export function readPendingArrival(raw: string | null | undefined): PendingArrival | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as { machine?: unknown; target?: { thread?: { path?: unknown }; newThread?: { draft?: unknown; workspaceId?: unknown } } };
    if (typeof value.machine !== "string" || !value.target) return undefined;
    const { thread, newThread } = value.target;
    if (thread && typeof thread.path === "string") return { machine: value.machine, target: { thread: { path: thread.path } } };
    if (!newThread || typeof newThread !== "object") return undefined;
    return {
      machine: value.machine,
      target: {
        newThread: {
          ...(typeof newThread.draft === "string" ? { draft: newThread.draft } : {}),
          ...(typeof newThread.workspaceId === "string" ? { workspaceId: newThread.workspaceId } : {}),
        },
      },
    };
  } catch {
    return undefined;
  }
}

const GB = 1024 ** 3;

function gigabytes(bytes: number): string {
  const value = bytes / GB;
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} GB`;
}

/** "2 cores · CPU 14 % · 5.2 of 8.0 GB free · 1 turn running · on battery". */
export function resourcesText(resources: HostResources): string {
  const parts = [
    `${resources.cpuCount} ${resources.cpuCount === 1 ? "core" : "cores"}`,
    resources.cpuUtilization !== undefined ? `CPU ${Math.round(resources.cpuUtilization * 100)} %` : undefined,
    `${gigabytes(resources.availableMemory)} of ${gigabytes(resources.totalMemory)} free`,
    resources.runningTurns > 0 ? `${resources.runningTurns} ${resources.runningTurns === 1 ? "turn" : "turns"} running` : "idle",
    resources.onBattery ? "on battery" : undefined,
  ];
  return parts.filter(Boolean).join(" · ");
}

const RUNTIME_STATE: Record<RuntimeReadinessState, string> = {
  "ready": "ready",
  "sign-in-required": "not signed in",
  "not-installed": "not installed",
  "unavailable": "unavailable",
  "checking": "not checked yet",
};

/** "Codex · not signed in"; a runtime's tooltip and name for assistive technology. */
export function runtimeText(runtime: RuntimeReadiness): string {
  const models = runtime.state === "ready" && runtime.models ? ` (${runtime.models} ${runtime.models === 1 ? "model" : "models"})` : "";
  return `${runtime.label} · ${RUNTIME_STATE[runtime.state]}${models}${runtime.version ? ` · ${runtime.version}` : ""}`;
}

const DISPLAY_TEXT: Record<HostDisplayKind, string> = {
  screen: "Screen",
  x11: "X display",
  wayland: "Wayland display",
  invisible: "Invisible display",
  none: "No display",
};

/** Git, disk and display as short facts, with `problem` saying why one keeps work from moving there. */
export function readinessFacts(readiness: HostReadiness): Array<{ text: string; title?: string; problem?: string }> {
  const { git, disk, display } = readiness;
  return [
    !git.version
      ? { text: "No Git", problem: "Git is not on its PATH." }
      : git.mergeTree
        ? { text: `Git ${git.version}` }
        : { text: `Git ${git.version}`, problem: `Git ${git.version} is older than 2.38: work coming back cannot be checked for conflicts before a merge.` },
    disk.free !== undefined
      ? { text: `${gigabytes(disk.free)} free for worktrees`, title: disk.path, ...(disk.free < 2 * GB ? { problem: `Less than 2 GB free in ${disk.path}.` } : {}) }
      : { text: "Free space unknown", title: disk.path, problem: `Could not look at ${disk.path}${disk.error ? `: ${disk.error}` : "."}` },
    { text: `${DISPLAY_TEXT[display.kind]}${display.name ? ` ${display.name}` : ""}` },
  ];
}
