import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { PullRequestList, PullRequestListState, RequestService, ReviewRequestContext } from "./protocol.js";
import type { RepositoryTarget, SourceControlProvider } from "./provider.js";
import type { SourceControl } from "./provider-registry.js";
import { SERVICES } from "./request-cli.js";

export const DEFAULT_LIST_LIMIT = 100;
/** "Load more" stops here; a narrower search finds the rest. */
export const MAX_LIST_LIMIT = 500;
const STATES: readonly PullRequestListState[] = ["open", "closed", "merged", "all"];

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};

/** Which repository a project's requests live in, from its remote; refuses with what is missing. */
export async function projectRepository(
  workspace: (command: string, input?: unknown) => Promise<unknown>,
  sources: SourceControl,
  project: string | undefined,
): Promise<RepositoryTarget & { git: ReviewRequestContext; service: RequestService; provider: SourceControlProvider }> {
  const git = await workspace("review-request-context", project ? { workspace: project } : undefined) as ReviewRequestContext;
  if (!git.remote) throw new HostCommandError("This project has no remote, so it has no pull requests to list.");
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
  context.registerCommand("pr-list", async (input): Promise<PullRequestList> => {
    const fields = record(input);
    const state = STATES.find((candidate) => candidate === fields.state) ?? "open";
    const asked = typeof fields.limit === "number" && Number.isFinite(fields.limit) ? Math.round(fields.limit) : DEFAULT_LIST_LIMIT;
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, asked));
    const search = typeof fields.search === "string" && fields.search.trim() ? fields.search.trim().slice(0, 200) : undefined;
    const project = typeof fields.workspace === "string" && fields.workspace ? fields.workspace : undefined;
    const { git, service, provider, host, repo } = await projectRepository(workspace, sources, project);
    const viewer = await sources.viewer(service, host);
    const { entries, more } = await provider.list({ host, repo, cwd: git.root }, { state, limit, ...(search ? { search } : {}) }, viewer);
    return {
      service,
      host,
      repo,
      ...(viewer ? { viewer } : {}),
      entries,
      truncated: more,
      limit,
    };
  }, { long: true });
}
