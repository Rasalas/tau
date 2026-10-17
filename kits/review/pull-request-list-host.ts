import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { PullRequestList, PullRequestLists, PullRequestListState, PullRequestStackMembership, RequestService, ReviewRequestContext } from "./protocol.js";
import type { RepositoryTarget, SourceControlProvider } from "./provider.js";
import type { SourceControl } from "./provider-registry.js";
import { SERVICES } from "./request-cli.js";

export const DEFAULT_LIST_LIMIT = 100;
/** "Load more" stops here; a narrower search finds the rest. */
export const MAX_LIST_LIMIT = 500;
const STATES: readonly PullRequestListState[] = ["open", "closed", "merged", "all"];
/** Projects one page across projects reads; repositories listed at once. */
const MAX_PROJECTS = 50;
const PARALLEL_LISTS = 4;
/** Projects whose Git is read at once; each read starts a few Git processes. */
const PARALLEL_PROJECTS = 8;

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};

/** A folder with no remote (or no repository): it has no requests to list, which is no failure. */
export class NoRemoteError extends HostCommandError {}

/** Which repository a project's requests live in, from its remote; refuses with what is missing. */
export async function projectRepository(
  workspace: (command: string, input?: unknown) => Promise<unknown>,
  sources: SourceControl,
  project: string | undefined,
): Promise<RepositoryTarget & { git: ReviewRequestContext; service: RequestService; provider: SourceControlProvider }> {
  const git = await workspace("review-request-context", project ? { workspace: project } : undefined) as ReviewRequestContext;
  if (!git.remote) throw new NoRemoteError("This project has no remote, so it has no pull requests to list.");
  const service = await sources.detect(git.remote.url);
  const provider = sources.get(service);
  const remote = provider.repository(git.remote.url);
  if (!remote) throw new HostCommandError(`${git.remote.name} (${git.remote.url}) names no server ${SERVICES[service].label} can reach.`);
  return { git, service, provider, ...remote };
}

/**
 * The Pull Requests page's host half: one project's requests in one state,
 * `limit` rows at most, searched on the host when there is text. Every
 * other filter runs on the rows in the page, so switching one never waits.
 */
export function registerPullRequestListCommands(
  context: HostExtensionContext,
  sources: SourceControl,
  workspace: (command: string, input?: unknown) => Promise<unknown>,
): void {
  const question = (fields: Record<string, unknown>) => {
    const state = STATES.find((candidate) => candidate === fields.state) ?? "open";
    const asked = typeof fields.limit === "number" && Number.isFinite(fields.limit) ? Math.round(fields.limit) : DEFAULT_LIST_LIMIT;
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, asked));
    const search = typeof fields.search === "string" && fields.search.trim() ? fields.search.trim().slice(0, 200) : undefined;
    return { state, limit, ...(search ? { search } : {}) };
  };

  const list = async (repository: Awaited<ReturnType<typeof projectRepository>>, input: ReturnType<typeof question>): Promise<PullRequestList> => {
    const { git, service, provider, host, repo } = repository;
    const viewer = await sources.viewer(service, host);
    const listed = await provider.list({ host, repo, cwd: git.root }, input, viewer);
    // Where the host keeps stacks, each open row says which layer it is.
    const open = listed.entries.filter((entry) => entry.state === "open").map((entry) => entry.ref.number);
    const stacks = provider.stackMemberships && provider.info.capabilities.stacks && open.length > 0
      ? await provider.stackMemberships({ host, repo }, open).catch(() => new Map<number, PullRequestStackMembership>())
      : new Map<number, PullRequestStackMembership>();
    const entries = stacks.size > 0 ? listed.entries.map((entry) => stacks.has(entry.ref.number) ? { ...entry, stack: stacks.get(entry.ref.number)! } : entry) : listed.entries;
    return { service, host, repo, ...(viewer ? { viewer } : {}), entries, truncated: listed.more, limit: input.limit };
  };

  context.registerCommand("pr-list", async (input): Promise<PullRequestList> => {
    const fields = record(input);
    const project = typeof fields.workspace === "string" && fields.workspace ? fields.workspace : undefined;
    return list(await projectRepository(workspace, sources, project), question(fields));
  }, { access: "read", long: true });

  /**
   * The page across projects: every named project's repository once, however
   * many checkouts share it, each listed as `pr-list` would. A folder with no
   * remote is left out; any other project that cannot be read is named with
   * its reason instead of failing the page.
   */
  context.registerCommand("pr-list-many", async (input): Promise<PullRequestLists> => {
    const fields = record(input);
    const named = (Array.isArray(fields.workspaces) ? fields.workspaces : []).filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, MAX_PROJECTS);
    const asked = question(fields);
    const failures: PullRequestLists["failures"] = [];
    const repositories = new Map<string, { repository: Awaited<ReturnType<typeof projectRepository>>; workspaces: string[] }>();
    const projects = [...new Set(named)];
    const resolveProjects = async () => {
      for (let project = projects.shift(); project !== undefined; project = projects.shift()) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- a few projects at a time: each starts Git
          const repository = await projectRepository(workspace, sources, project);
          const key = `${repository.service}\0${repository.host}\0${repository.repo.toLowerCase()}`;
          const known = repositories.get(key);
          if (known) known.workspaces.push(project); else repositories.set(key, { repository, workspaces: [project] });
        } catch (error) {
          if (!(error instanceof NoRemoteError)) failures.push({ workspace: project, message: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_PROJECTS }, resolveProjects));
    const queue = [...repositories.values()];
    const lists: PullRequestLists["lists"] = [];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- a few repositories at a time: each asks a host
          lists.push({ ...await list(next.repository, asked), workspaces: next.workspaces });
        } catch (error) {
          for (const project of next.workspaces) failures.push({ workspace: project, message: error instanceof Error ? error.message : String(error) });
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_LISTS }, worker));
    lists.sort((left, right) => `${left.host}/${left.repo}`.localeCompare(`${right.host}/${right.repo}`));
    return { lists, failures };
  }, { access: "read", long: true });
}
