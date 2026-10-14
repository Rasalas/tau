import { HostCommandError } from "tau/host-extension";
import type { ProviderTools } from "./provider.js";
import type { PullRequestRef } from "./protocol.js";
import type { FailedCheck, WatchSnapshot } from "./pr-watch-protocol.js";
import { isRateLimited, RateLimitError, retryAtFromCli } from "./provider-rate-limit.js";

const REMARK = "id updatedAt author { login }";
const PAGE = "pageInfo { hasNextPage endCursor }";
/** Metadata only, no bodies, files or logs. At most 5 PR aliases, below GitHub's 500k node limit. */
export const WATCH_FIELDS = `
  id state mergeable headRefOid
  comments(first:100) { ${PAGE} nodes { ${REMARK} } }
  reviews(first:100) { ${PAGE} nodes { ${REMARK} state } }
  reviewThreads(first:100) { ${PAGE} nodes { id comments(first:100) { ${PAGE} nodes { ${REMARK} } } } }
  commits(last:1) { nodes { commit {
    checkSuites(first:100) { pageInfo { hasNextPage } nodes { status workflowRun { databaseId } } }
    statusCheckRollup { state contexts(first:100) { pageInfo { hasNextPage } nodes { ... on CheckRun { databaseId name status conclusion } ... on StatusContext { context state targetUrl } } } }
  } } }`;
export function watchQuery(refs: readonly PullRequestRef[]): string {
  return `query { viewer { login } rateLimit { cost remaining resetAt } ${refs.map((ref, i) => {
    const [owner, repo] = ref.repo.split("/");
    return `p${i}: repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(repo)}) { pullRequest(number:${ref.number}) { ${WATCH_FIELDS} } }`;
  }).join("\n")} }`;
}
interface Remark { id: string; updatedAt: string; state?: string; author?: { login?: string } }
interface Connection<T> { nodes?: T[]; pageInfo?: { hasNextPage?: boolean; hasPreviousPage?: boolean; endCursor?: string } }
interface ReviewThread { id: string; comments: Connection<Remark> }
interface WatchPr {
  id: string; state: WatchSnapshot["state"]; headRefOid: string; mergeable?: string;
  comments?: Connection<Remark>; reviews?: Connection<Remark>; reviewThreads?: Connection<ReviewThread>;
  commits?: { nodes?: { commit?: { checkSuites?: Connection<{ status?: string; workflowRun?: unknown }>; statusCheckRollup?: { state?: string; contexts?: Connection<CheckContext> } } }[] };
}
interface CheckContext { databaseId?: number; name?: string; status?: string; conclusion?: string; context?: string; state?: string; targetUrl?: string }
const PENDING = new Set<unknown>(["PENDING", "EXPECTED"]);
const FAILED_STATES = new Set<unknown>(["FAILURE", "ERROR"]);
const FAILED_CONCLUSIONS = new Set<unknown>(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
type Session = { identity: string; cli: ProviderTools["cli"] };
interface Entry { ref: PullRequestRef; session: Session; resolve(snapshot: WatchSnapshot): void; reject(error: unknown): void }
const queues = new WeakMap<ProviderTools, Map<string, Entry[]>>();
interface GraphqlResult {
  data?: { viewer?: { login?: string }; node?: Record<string, Connection<Remark | ReviewThread>> } & Partial<Record<`p${number}`, { pullRequest?: WatchPr }>>;
  errors?: { path?: unknown[]; message?: string; type?: string }[];
}
async function graphql(tools: ProviderTools, session: Session, host: string, query: string): Promise<GraphqlResult> {
  const inspect = (output: string) => {
    const start = output.indexOf("{");
    let errors: GraphqlResult["errors"];
    try { errors = JSON.parse(output.slice(start)).errors; } catch { /* decoder reports malformed JSON below */ }
    if (/^HTTP\/\S+ 429/imu.test(output) || errors?.some((error) => error.type === "RATE_LIMITED" || isRateLimited(error.message ?? ""))) {
      throw new RateLimitError("GitHub rate limit reached.", retryAtFromCli(output, tools.now?.() ?? Date.now()) ?? 0);
    }
  };
  const output = await session.cli("github", { args: ["api", "graphql", "--hostname", host, "--include", "-f", `query=${query}`] }, "Watching pull requests", { host, inspect, maxBuffer: 16 * 1024 * 1024,
    acceptFailure: (stdout, exitCode) => {
      // gh exits 1 for HTTP-200 partial GraphQL errors. Only complete JSON from
      // that response is usable; quota inspection still runs inside the gate.
      if (exitCode !== 1 || !/^HTTP\/\S+ 200\b/iu.test(stdout)) return false;
      try {
        const errors = JSON.parse(stdout.slice(stdout.indexOf("{"))).errors;
        return Array.isArray(errors) && errors.length > 0;
      } catch { return false; }
    },
  });
  inspect(output);
  const json = output.slice(output.indexOf("{"));
  const result = JSON.parse(json);
  return result;
}
async function decode(tools: ProviderTools, session: Session, ref: PullRequestRef, pr: WatchPr): Promise<WatchSnapshot> {
  if (!pr || !["OPEN", "MERGED", "CLOSED"].includes(pr.state) || typeof pr.headRefOid !== "string") throw new HostCommandError("GitHub did not return a readable pull request.");
  // 30 pages per connection, 100 extra pages per PR per poll. Refuse partial fingerprints.
  let pages = 0;
  const complete = async <T>(connection: Connection<T> | undefined, id: string, type: string, field: string, selection: string): Promise<T[]> => {
    const nodes = [...connection?.nodes ?? []];
    let info = connection?.pageInfo;
    if (tools.githubSession && (!connection?.nodes || !info)) throw new HostCommandError("GitHub did not return complete PR watch coverage.");
    if (info?.hasPreviousPage) throw new HostCommandError("GitHub returned incomplete coverage: more than 100 items without a forward cursor.");
    for (let page = 1; info?.hasNextPage; page++) {
      if (page >= 30 || ++pages > 100 || !info.endCursor || !id) throw new HostCommandError("PR watch coverage exceeds its pagination limit (30 pages per connection, 100 extra pages per poll).");
      const result = await graphql(tools, session, ref.host, `query { node(id:${JSON.stringify(id)}) { ... on ${type} { ${field}(first:100,after:${JSON.stringify(info.endCursor)}) { ${PAGE} nodes { ${selection} } } } } }`);
      const next: Connection<T> | undefined = result.data?.node?.[field] as Connection<T> | undefined;
      if (result.errors?.length || !next?.nodes || !next.pageInfo || next.pageInfo.endCursor === info.endCursor) throw new HostCommandError("GitHub did not return complete PR watch coverage.");
      nodes.push(...next.nodes); info = next.pageInfo;
    }
    return nodes;
  };
  const comments = await complete(pr.comments, pr.id, "PullRequest", "comments", REMARK);
  const reviews = await complete(pr.reviews, pr.id, "PullRequest", "reviews", `${REMARK} state`);
  const threads = await complete(pr.reviewThreads, pr.id, "PullRequest", "reviewThreads", `id comments(first:100) { ${PAGE} nodes { ${REMARK} } }`);
  const replies: Remark[] = [];
  for (const thread of threads) {
    // oxlint-disable-next-line no-await-in-loop -- bounded recovery; do not flood GitHub with pages.
    replies.push(...await complete(thread.comments, thread.id, "PullRequestReviewThread", "comments", REMARK));
  }
  const fingerprint = (rows: Remark[]) => rows.map((row) => [row.id, row.updatedAt, row.state ?? ""]).sort((a, b) => a[0]!.localeCompare(b[0]!));
  const commit = pr.commits?.nodes?.[0]?.commit, rollup = commit?.statusCheckRollup;
  if (rollup?.contexts?.pageInfo?.hasNextPage || commit?.checkSuites?.pageInfo?.hasNextPage) throw new HostCommandError("This PR has more than 100 checks; watching cannot reliably detect every check finishing.");
  const contexts: CheckContext[] = rollup?.contexts?.nodes ?? [];
  // A workflow run stays unfinished until its later jobs (like smoke) have run, before their check runs exist.
  const running = (commit?.checkSuites?.nodes ?? []).some((suite: { status?: string; workflowRun?: unknown }) => suite.workflowRun && suite.status !== "COMPLETED");
  const pending = running || PENDING.has(rollup?.state) || contexts.some((node) => node.context ? PENDING.has(node.state) : node.status !== undefined && node.status !== "COMPLETED");
  const failed = contexts.flatMap((node): FailedCheck[] => node.context
    ? FAILED_STATES.has(node.state) ? [{ id: `${node.context} ${node.targetUrl ?? ""}`, name: node.context }] : []
    : node.status === "COMPLETED" && FAILED_CONCLUSIONS.has(node.conclusion) ? [{ id: String(node.databaseId), name: node.name ?? "check" }] : []);
  const checks = pending ? "pending" : rollup ? "done" : "none";
  return { state: pr.state, head: pr.headRefOid, checks, failed, comments: JSON.stringify([fingerprint(comments), fingerprint(reviews), fingerprint(replies)]), conflict: pr.mergeable === "CONFLICTING" };
}
async function flush(tools: ProviderTools, entries: Entry[]): Promise<void> {
  // Sequential groups cap concurrent API requests, including pagination recovery.
  for (let start = 0; start < entries.length; start += 5) {
    const group = entries.slice(start, start + 5), first = group[0]!;
    try {
      // oxlint-disable-next-line no-await-in-loop -- bounded groups, one API request at a time.
      const result = await graphql(tools, first.session, first.ref.host, watchQuery(group.map((entry) => entry.ref)));
      for (const [index, entry] of group.entries()) {
        try {
          const affected = result.errors?.some((error: { path?: unknown[] }) => !error.path?.length || error.path[0] === `p${index}`);
          let pr = result.data?.[`p${index}`]?.pullRequest;
          if (!pr || affected) {
            // Missing/partial aliases get one fresh standalone read, never a cached answer.
            // oxlint-disable-next-line no-await-in-loop -- conservative fallback, one request per missing alias.
            const fallback = await graphql(tools, entry.session, entry.ref.host, watchQuery([entry.ref]));
            if (fallback.errors?.length) throw new HostCommandError("GitHub did not return a readable pull request.");
            pr = fallback.data?.p0?.pullRequest;
          }
          // oxlint-disable-next-line no-await-in-loop -- pagination remains bounded and serial.
          if (!pr) throw new HostCommandError("GitHub did not return a readable pull request.");
          // oxlint-disable-next-line no-await-in-loop -- complete coverage precedes fingerprint publication.
          entry.resolve(await decode(tools, entry.session, entry.ref, pr));
        } catch (error) { entry.reject(error); }
      }
    } catch (error) { for (const entry of group) entry.reject(error); }
  }
}
/** Fresh reads share in flight and batch by host plus pinned credential, never completed snapshots. */
export async function readWatchSnapshot(tools: ProviderTools, ref: PullRequestRef): Promise<WatchSnapshot> {
  const session = await tools.githubSession?.(ref.host) ?? { identity: "unscoped", cli: tools.cli.bind(tools) };
  return tools.cached(`watch:${session.identity}`, ref, true, () => new Promise<WatchSnapshot>((resolve, reject) => {
    let hosts = queues.get(tools);
    if (!hosts) { hosts = new Map(); queues.set(tools, hosts); }
    const key = `${ref.host.toLowerCase()}\0${session.identity}`;
    const pending = hosts.get(key);
    const entry = { ref, session, resolve, reject };
    if (pending) { pending.push(entry); return; }
    const entries = [entry]; hosts.set(key, entries);
    queueMicrotask(() => { hosts.delete(key); void flush(tools, entries); });
  }), true);
}
