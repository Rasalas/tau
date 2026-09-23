import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { PullRequestList, PullRequestListEntry, PullRequestListState, ReviewRequestContext } from "./protocol.js";
import { listCall } from "./pull-request-cli.js";
import { parseRemote, type Hosting } from "./pull-request-hosting.js";
import { parseGitHubList, parseGitLabList } from "./pull-request-list-json.js";
import { serviceFor, SERVICES } from "./request-cli.js";

export const DEFAULT_LIST_LIMIT = 100;
/** "Load more" stops here; a narrower search finds the rest. */
export const MAX_LIST_LIMIT = 500;
const LIST_BUFFER = 32 * 1024 * 1024;
const STATES: readonly PullRequestListState[] = ["open", "closed", "merged", "all"];

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};

/** Which repository a project's requests live in, from its remote; refuses with what is missing. */
export async function projectRepository(
  workspace: (command: string, input?: unknown) => Promise<unknown>,
  findCommand: (name: string) => string | undefined,
  project: string | undefined,
): Promise<{ git: ReviewRequestContext; service: "github" | "gitlab"; host: string; repo: string }> {
  const git = await workspace("review-request-context", project ? { workspace: project } : undefined) as ReviewRequestContext;
  if (!git.remote) throw new HostCommandError("This project has no remote, so it has no pull requests to list.");
  const remote = parseRemote(git.remote.url);
  const service = serviceFor(git.remote.url, findCommand);
  if (!remote) throw new HostCommandError(`${git.remote.name} (${git.remote.url}) names no server ${SERVICES[service].label} can reach.`);
  return { git, service, ...remote };
}

/**
 * The Pull Requests page's host half: one project's requests in one state,
 * `limit` rows at most, searched on the host when there is text. Every
 * other filter runs on the rows in the page, so switching one never waits.
 */
export function registerPullRequestListCommands(
  context: HostExtensionContext,
  hosting: Hosting,
  workspace: (command: string, input?: unknown) => Promise<unknown>,
): void {
  const { services } = context;
  context.registerCommand("pr-list", async (input): Promise<PullRequestList> => {
    const fields = record(input);
    const state = STATES.find((candidate) => candidate === fields.state) ?? "open";
    const asked = typeof fields.limit === "number" && Number.isFinite(fields.limit) ? Math.round(fields.limit) : DEFAULT_LIST_LIMIT;
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, asked));
    const search = typeof fields.search === "string" && fields.search.trim() ? fields.search.trim().slice(0, 200) : undefined;
    const project = typeof fields.workspace === "string" && fields.workspace ? fields.workspace : undefined;
    const { git, service, host, repo } = await projectRepository(workspace, (name) => services.findCommand(name), project);
    const noun = SERVICES[service].noun;
    const viewer = await hosting.viewer(service, host);
    let entries: PullRequestListEntry[];
    if (service === "github") {
      const output = await hosting.cli(service, listCall(service, host, repo, { state, limit, ...(search ? { search } : {}) }), `Listing the ${noun}s of ${repo}`, { maxBuffer: LIST_BUFFER, cwd: git.root });
      entries = parseGitHubList(output, viewer);
    } else {
      entries = [];
      for (let page = 1; entries.length <= limit; page += 1) {
        const output = await hosting.cli(service, listCall(service, host, repo, { state, limit, page, ...(search ? { search } : {}) }), `Listing the ${noun}s of ${repo}`, { maxBuffer: LIST_BUFFER, cwd: git.root });
        const batch = parseGitLabList(output, viewer);
        entries.push(...batch);
        if ((JSON.parse(output) as unknown[]).length < 100) break;
      }
    }
    return {
      service,
      host,
      repo,
      ...(viewer ? { viewer } : {}),
      entries: entries.slice(0, limit),
      truncated: entries.length > limit,
      limit,
    };
  }, { long: true });
}
