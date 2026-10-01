import { useEffect, useSyncExternalStore } from "react";
import { errorMessage, type HostExtensionClient, type NewThreadClaimEvent, type PlatformEnvironments, type PromptHookContribution, type UiEnvironment, type UiEnvironments, type WorkbenchActions } from "tau";

/** Remote Work Kit (`kits/remote-work/protocol.ts`), named here: a kit never imports another. */
export const REMOTE_WORK_EXTENSION_ID = "tau.remote-work";
const PROJECT_IDENTITIES_COMMAND = "project-identities";
const THREAD_START_COMMAND = "thread-start";
const THREAD_LINK_EVENT = "thread-link";
/** Remote Work Kit's settings page, where such a thread's work is brought back and merged. */
const REMOTE_WORK_SETTINGS_PAGE = "remote-work.settings";

/**
 * Where a new thread of this project would run on a machine: its own checkout
 * of the same repository there, or none yet, so Tau takes the project along.
 */
export type ProjectMatch = { found: true; workspaceId?: string } | { found: false };

function folderName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() ?? path;
}

/**
 * The repository decides (`key`, Remote Work's identity of the project here,
 * and `keys`, that machine's of its projects); a folder of the same name only
 * where either side could not say, as before identities.
 */
export function matchProject(machine: UiEnvironment, projectPath: string | undefined, key: string | null | undefined, keys: Readonly<Record<string, string | null>> | undefined): ProjectMatch {
  if (key && keys) {
    const project = machine.projects.find((entry) => entry.workspaceId !== undefined && keys[entry.workspaceId] === key);
    return project ? { found: true, ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}) } : { found: false };
  }
  const name = projectPath ? folderName(projectPath) : undefined;
  const project = machine.projects.find((entry) => entry.name === name);
  return project ? { found: true, ...(project.workspaceId ? { workspaceId: project.workspaceId } : {}) } : { found: false };
}

const signature = (machine: UiEnvironment) => machine.projects.map((project) => project.workspaceId ?? "").join(",");

/**
 * Projects' identities, here and on the other machines, read once per list:
 * Remote Work Kit answers them on each side, and a machine without it (or
 * an older one) is matched by folder name.
 */
export function createProjectIdentities(environments: PlatformEnvironments, remoteWork: HostExtensionClient | undefined) {
  const listeners = new Set<() => void>();
  const here = new Map<string, string | null>();
  const there = new Map<string, { signature: string; keys?: Record<string, string | null> }>();
  let version = 0;
  const changed = () => { version += 1; listeners.forEach((listener) => listener()); };
  const asked = new Set<string>();

  const askHere = (projectPath: string) => {
    if (!remoteWork || here.has(projectPath) || asked.has(`here:${projectPath}`)) return;
    asked.add(`here:${projectPath}`);
    remoteWork.invoke(PROJECT_IDENTITIES_COMMAND, { workspaces: [projectPath] }).then(
      (answer) => { here.set(projectPath, (answer as Record<string, string | null> | undefined)?.[projectPath] ?? null); },
      () => { here.set(projectPath, null); },
    ).finally(() => { asked.delete(`here:${projectPath}`); changed(); });
  };
  const askThere = (machine: UiEnvironment) => {
    const read = environments.readExtension;
    const current = signature(machine);
    if (!read || machine.local || machine.status !== "connected" || there.get(machine.id)?.signature === current || asked.has(machine.id)) return;
    const workspaces = machine.projects.flatMap((project) => project.workspaceId ? [project.workspaceId] : []);
    asked.add(machine.id);
    read(machine.id, REMOTE_WORK_EXTENSION_ID, PROJECT_IDENTITIES_COMMAND, { workspaces }).then(
      (answer) => { there.set(machine.id, { signature: current, keys: (answer ?? {}) as Record<string, string | null> }); },
      () => { there.set(machine.id, { signature: current }); },
    ).finally(() => { asked.delete(machine.id); changed(); });
  };

  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getVersion: () => version,
    /** Asks what is not known yet; the answers come with a change. */
    ask(list: UiEnvironments, projectPath: string | undefined) {
      if (projectPath) askHere(projectPath);
      for (const machine of list.environments) askThere(machine);
    },
    /** Whether the project here is a repository with a commit, as Remote Work Kit reads it: what taking it along needs. */
    movable: (projectPath: string | undefined): boolean => Boolean(projectPath && here.get(projectPath)),
    match(machine: UiEnvironment, projectPath: string | undefined): ProjectMatch {
      return matchProject(machine, projectPath, projectPath ? here.get(projectPath) : undefined, there.get(machine.id)?.keys);
    },
  };
}

export type ProjectIdentities = ReturnType<typeof createProjectIdentities>;

/** Matches for the draft's project, asked while it is on screen. */
export function useProjectMatches(identities: ProjectIdentities, list: UiEnvironments | undefined, projectPath: string | undefined) {
  useSyncExternalStore(identities.subscribe, identities.getVersion);
  useEffect(() => { if (list) identities.ask(list, projectPath); }, [identities, list, projectPath]);
  return (machine: UiEnvironment) => identities.match(machine, projectPath);
}

/** A draft whose thread starts on a machine without its project: Tau takes the project there when it is sent. */
export interface BringChoice {
  machine: string;
  machineName: string;
  projectPath: string;
}

export function createBringChoice() {
  const listeners = new Set<() => void>();
  let choice: BringChoice | undefined;
  return {
    get: () => choice,
    set(next: BringChoice | undefined) { choice = next; listeners.forEach((listener) => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export type BringChoiceStore = ReturnType<typeof createBringChoice>;

interface ThreadLink {
  id: string;
  machine: string;
  machineName: string;
  thread?: string;
  status: string;
  error?: string;
}

/**
 * Sends a new thread's first prompt to the machine it was set to run on when
 * that machine has no checkout of its project: Remote Work Kit takes the
 * project's state there (commits, uncommitted and untracked work) into a
 * worktree and starts the thread in it (`thread-start`, as handoff does). The
 * window stays here; the thread joins the list from that machine, and a
 * notice says when it runs there or why it could not.
 */
export function createBringProjectHook(choice: BringChoiceStore, remoteWork: HostExtensionClient, environments: PlatformEnvironments): PromptHookContribution {
  const follow = (link: ThreadLink, projectName: string, actions: WorkbenchActions) => {
    let done = false;
    const stop = remoteWork.onEvent(THREAD_LINK_EVENT, (payload) => {
      const next = payload as ThreadLink;
      if (done || next?.id !== link.id) return;
      if (next.status === "failed") {
        done = true;
        stop();
        actions.toast?.({ type: "error", title: `The thread did not start on ${next.machineName}`, description: next.error ?? "Settings → Remote work shows what happened.", timeoutMs: 0 });
        return;
      }
      if (!next.thread || next.status === "sending" || next.status === "starting") return;
      done = true;
      stop();
      actions.toast?.({
        type: "success",
        title: `Runs on ${next.machineName}`,
        description: `${projectName} is there now, in a worktree of its own. Its work comes back as a branch from Settings → Remote work.`,
        actions: [
          ...(environments.watchThread ? [{ label: "Look in", run: () => actions.openThread(next.thread!, { pin: true, machine: next.machine }) }] : []),
          { label: "Remote work", run: () => actions.openSettings(REMOTE_WORK_SETTINGS_PAGE) },
        ],
      });
    });
  };
  return {
    id: "environments.bring-project",
    async claimNewThread(event: NewThreadClaimEvent, actions: WorkbenchActions) {
      const chosen = choice.get();
      if (!chosen || chosen.projectPath !== event.projectPath) return false;
      if (event.attachments > 0) throw new Error(`Attachments cannot go along to ${chosen.machineName} yet; send them once the thread runs there, or start it here.`);
      const projectName = folderName(event.projectPath);
      event.preparing(`Taking ${projectName} to ${chosen.machineName}…`);
      let link: ThreadLink;
      try {
        link = await remoteWork.invoke(THREAD_START_COMMAND, {
          machine: chosen.machine,
          cwd: event.projectPath,
          prompt: event.prompt,
          backend: event.runtime,
          ...(event.model ? { model: event.model } : {}),
        }) as ThreadLink;
      } catch (error) {
        throw new Error(`Could not start on ${chosen.machineName}: ${errorMessage(error)}`, { cause: error });
      }
      choice.set(undefined);
      follow(link, projectName, actions);
      actions.notify(`${projectName} is on its way to ${chosen.machineName}; the thread starts there once it arrives.`);
      return true;
    },
  };
}
