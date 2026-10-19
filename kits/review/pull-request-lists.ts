import { useEffect, useState } from "react";
import { errorMessage, useThreadStore, type ThreadStore, type UiProject, type UiSession } from "tau";
import type { PullRequestClient } from "./pull-request-client.js";
import type { PullRequestListState, PullRequestLists } from "./protocol.js";

/** The project ids to list on each machine; `""` is the host this window talks to. */
export type ProjectsByMachine = ReadonlyMap<string, { name: string; workspaces: string[] }>;

/** Projects whose threads run on another machine live there; that machine's host lists them. */
export function projectsByMachine(projects: readonly UiProject[], threads: readonly Pick<UiSession, "workspaceId" | "machine">[]): ProjectsByMachine {
  const homes = new Map(threads.flatMap((thread) => thread.machine && thread.workspaceId ? [[thread.workspaceId, thread.machine] as const] : []));
  // This host is always asked, as it was before machines: a page with no projects still has its answer.
  const groups = new Map<string, { name: string; workspaces: string[] }>([["", { name: "", workspaces: [] }]]);
  for (const project of projects) {
    const id = projectId(project);
    const home = homes.get(id);
    const key = home?.id ?? "";
    const group = groups.get(key) ?? { name: home?.name ?? "", workspaces: [] };
    group.workspaces.push(id);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Every machine's answer as one: this host's lists first, a repository listed
 * twice only once. Another machine's rows open without a project here.
 */
export async function listAcrossMachines(client: PullRequestClient, machines: ProjectsByMachine, asking: { state: PullRequestListState; limit: number; search?: string }): Promise<PullRequestLists> {
  const answers = await Promise.all([...machines].map(async ([machine, { name, workspaces }]): Promise<PullRequestLists> => {
    if (!machine) return client.listMany({ ...asking, workspaces });
    const failed = (message: string) => ({ lists: [], failures: workspaces.map((workspace) => ({ workspace, message })) });
    if (!client.listManyOn) return failed(`Its threads run on ${name}, which this window does not reach.`);
    return client.listManyOn(machine, { ...asking, workspaces }).then(
      (answer) => ({ lists: answer.lists.map((list) => ({ ...list, workspaces: [] })), failures: answer.failures }),
      (error: unknown) => failed(`${name} did not answer: ${errorMessage(error)}`),
    );
  }));
  const seen = new Set<string>();
  return {
    lists: answers.flatMap((answer) => answer.lists).filter((list) => {
      const key = `${list.host}/${list.repo}`.toLowerCase();
      return !seen.has(key) && Boolean(seen.add(key));
    }),
    failures: answers.flatMap((answer) => answer.failures),
  };
}

/** The projects the window knows, once per workspace, by the machine that lists them; outside a workbench there are none. */
export function useProjects(): { projects: readonly UiProject[]; machines: ProjectsByMachine } {
  let store: ThreadStore | undefined;
  try { store = useThreadStore(); } catch { store = undefined; }
  const read = (): { projects: readonly UiProject[]; machines: ProjectsByMachine } => {
    const projects = store?.getProjects() ?? [];
    return { projects, machines: projectsByMachine(projects, store?.getSnapshot().threads ?? []) };
  };
  const [state, setState] = useState(read);
  useEffect(() => {
    if (!store) return undefined;
    // Threads change often; a new answer only when a project or its machine did.
    const update = () => setState((current) => {
      const next = read();
      return JSON.stringify([...next.machines]) === JSON.stringify([...current.machines]) && next.projects === current.projects ? current : next;
    });
    const offProjects = store.subscribeToProjects(update);
    const offThreads = store.subscribe(update);
    return () => { offProjects(); offThreads(); };
  }, [store]);
  return state;
}

export const projectId = (project: UiProject) => project.workspaceId ?? project.path;

/** The threads the window lists, read when called; none outside a workbench. */
export function useThreadReader(): () => readonly UiSession[] {
  let store: ThreadStore | undefined;
  try { store = useThreadStore(); } catch { store = undefined; }
  return () => store?.getSnapshot().threads ?? [];
}
