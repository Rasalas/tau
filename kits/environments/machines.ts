import type { EnvironmentTarget, UiEnvironment, UiEnvironments, WorkbenchActions } from "tau";

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
}

/**
 * Opens what the page was sent to this machine for. The page may still be
 * starting, so each step is tried again until the workbench has it.
 */
export async function followArrival(target: EnvironmentTarget, ports: ArrivalPorts): Promise<boolean> {
  // A machine seen for the first time may show its first-start steps before the workbench.
  const tries = ports.tries ?? 480;
  const { actions } = ports;
  if ("thread" in target) {
    for (let attempt = 0; attempt < tries; attempt += 1) {
      if (await actions.switchSession(target.thread.path).catch(() => false)) return true;
      await ports.wait(250);
    }
    return false;
  }
  const { draft, workspaceId } = target.newThread;
  for (let attempt = 0; attempt < tries; attempt += 1) {
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
