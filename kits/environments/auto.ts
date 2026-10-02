import { useEffect, useState, useSyncExternalStore } from "react";
import { errorMessage, getClientStorage, type HostExtensionClient, type NewThreadClaimEvent, type PlatformEnvironments, type PromptHookContribution, type UiEnvironment, type UiEnvironments, type WorkbenchActions } from "tau";
import type { BringChoiceStore, ProjectIdentities, ProjectMatch } from "./bring-project.js";
import { shownMachine } from "./machines.js";
import { CHOOSE_MACHINE_COMMAND, type AgentMachines, type ChooseMachineAnswer, type ChooseMachineInput } from "./protocol.js";

/** "Run on: Automatic" stays chosen for the next drafts of this window, until a machine is picked. */
export const RUN_ON_KEY = "tau.environments.run-on";

const listeners = new Set<() => void>();

export const autoRunOn = {
  get: (): boolean => getClientStorage()?.get(RUN_ON_KEY) === "auto",
  set(on: boolean): void {
    const storage = getClientStorage();
    if (on) storage?.set(RUN_ON_KEY, "auto");
    else storage?.remove(RUN_ON_KEY);
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

export function useAutoRunOn(): boolean {
  return useSyncExternalStore(autoRunOn.subscribe, autoRunOn.get, autoRunOn.get);
}

function folderName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() ?? path;
}

/**
 * The other machines a new thread of this project could start on, with the
 * project there: connected, Full access, and a checkout of the same
 * repository (`match`, from Remote Work's identities), else a project of the
 * same name.
 */
export function threadTargets(list: UiEnvironments, projectPath: string | undefined, match?: (machine: UiEnvironment) => ProjectMatch): Map<string, string | undefined> {
  const name = projectPath ? folderName(projectPath) : undefined;
  const targets = new Map<string, string | undefined>();
  for (const machine of list.environments) {
    if (machine.local || machine.status !== "connected" || machine.readOnly) continue;
    if (match) {
      const found = match(machine);
      if (found.found) targets.set(machine.id, found.workspaceId);
      continue;
    }
    const project = machine.projects.find((entry) => entry.name === name);
    if (project) targets.set(machine.id, project.workspaceId);
  }
  return targets;
}

/** Automatic applies only while the window shows this computer, whose host does the choosing. */
export function autoApplies(environments: PlatformEnvironments, list: UiEnvironments | undefined): list is UiEnvironments {
  return Boolean(list && !environments.shownElsewhere && shownMachine(list)?.local);
}

export function chooseInput(targets: ReadonlyMap<string, unknown>, cwd: string | undefined, backend: string | undefined, model: { provider: string; id: string } | undefined): ChooseMachineInput {
  return {
    purpose: "thread",
    ...(cwd ? { cwd } : {}),
    ...(backend ? { backend } : {}),
    ...(model ? { model: `${model.provider}/${model.id}` } : {}),
    machines: [...targets.keys()],
  };
}

const PREVIEW_MS = 10_000;

/**
 * The choice as it stands, asked again every 10 s while the chip shows
 * Automatic; that also keeps the readings fresh for the send.
 */
export function useAutoPreview(host: HostExtensionClient | undefined, input: ChooseMachineInput | undefined): { answer?: ChooseMachineAnswer; error?: string } {
  const [state, setState] = useState<{ answer?: ChooseMachineAnswer; error?: string }>({});
  const key = input ? JSON.stringify(input) : "";
  useEffect(() => {
    if (!host || !input) return undefined;
    let live = true;
    const ask = () => {
      host.invoke(CHOOSE_MACHINE_COMMAND, input).then(
        (answer) => { if (live) setState({ answer: answer as ChooseMachineAnswer }); },
        (error: unknown) => { if (live) setState({ error: errorMessage(error) }); },
      );
    };
    ask();
    const timer = setInterval(ask, PREVIEW_MS);
    return () => { live = false; clearInterval(timer); };
  }, [host, key]);
  return input ? state : {};
}

/**
 * Sends a new thread's first prompt where Automatic chooses, when it is sent:
 * here unclaimed, or claimed and carried to the other machine, which sends it
 * there. A thread that started stays where it runs.
 */
export function createAutoRunOnHook(environments: PlatformEnvironments, host: HostExtensionClient, identities?: ProjectIdentities, runOn?: { choice: BringChoiceStore; hook: PromptHookContribution }): PromptHookContribution {
  return {
    id: "environments.auto-run-on",
    async claimNewThread(event: NewThreadClaimEvent, actions: WorkbenchActions) {
      const list = environments.getSnapshot();
      if (!autoRunOn.get() || !autoApplies(environments, list)) return false;
      const targets = threadTargets(list, event.projectPath, identities && ((machine) => identities.match(machine, event.projectPath)));
      if (targets.size === 0) return false;
      if (event.attachments > 0) {
        actions.notify("Attachments stay on this computer, so Automatic starts this thread here.");
        return false;
      }
      event.preparing("Choosing a machine…");
      let answer: ChooseMachineAnswer;
      try {
        answer = await host.invoke(CHOOSE_MACHINE_COMMAND, chooseInput(targets, event.projectPath, event.runtime, event.model)) as ChooseMachineAnswer;
      } catch (error) {
        actions.notify(`Automatic could not choose (${errorMessage(error)}); this thread starts here.`);
        return false;
      }
      if (!answer.machine || !targets.has(answer.machine)) return false;
      const workspaceId = targets.get(answer.machine);
      if (runOn && workspaceId) {
        const agents = await host.invoke("agents").catch(() => undefined) as AgentMachines | undefined;
        const agent = agents?.machines?.find((machine) => machine.id === answer.machine);
        if (agent?.status === "connected" && !agent.readOnly) {
          const machine = list.environments.find((entry) => entry.id === answer.machine)!;
          runOn.choice.set({ machine: machine.id, machineName: machine.name, projectPath: event.projectPath, workspaceId });
          return runOn.hook.claimNewThread?.(event, actions);
        }
      }
      try {
        // The page reloads there before this answers; the prompt goes with it and is sent on arrival.
        await environments.open(answer.machine, {
          newThread: { draft: event.prompt, send: true, ...(workspaceId ? { workspaceId } : {}), ...(event.model ? { model: event.model } : {}) },
        });
      } catch (error) {
        actions.notify(`Could not move to the chosen machine (${errorMessage(error)}); this thread starts here.`);
        return false;
      }
      return true;
    },
  };
}
