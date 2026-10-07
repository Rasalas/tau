import { Type } from "typebox";
import { join } from "node:path";
import { HostCommandError, readPersistedJson, writePersistedJson, type HostExtensionContext, type HostMcpTool, type RuntimeSessionInfo } from "tau/host-extension";
import type { SourceControl } from "./provider-registry.js";
import type { ThreadLinks } from "./thread-links-host.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { readWatchSnapshot } from "./pr-watch-github.js";
import { watchChanges, type PullRequestWatch, type WatchSnapshot } from "./pr-watch-protocol.js";
const PERIOD = 60_000;
const UNREADABLE_LIMIT = 15 * 60_000;
const RAIL = "tau.thread-rail";
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 400);
const key = (watch: Pick<PullRequestWatch, "threadId" | "ref">) => `${watch.threadId}:${watch.ref.url}`;
/** In every runtime's system prompt, so an agent waits on a PR with a watch instead of a polling loop. */
export const WATCH_INSTRUCTIONS = `<pull_request_watching>
When your next step waits on a GitHub pull request, such as its checks finishing or a review arriving, call watch_pull_request with its full URL, tell the user, and end your turn. Tau then queues a message into this thread when checks finish, someone comments or reviews, the branch conflicts, or the request is merged or closed, and you continue from there. Do not wait with gh pr checks --watch, sleep or a background polling loop. A watch never merges or edits the request. Call unwatch_pull_request when you no longer need it.
</pull_request_watching>`;
function decode(value: unknown): PullRequestWatch[] {
  value = fields(value).watches;
  if (!Array.isArray(value) || value.length > 100) throw new HostCommandError("Invalid PR watch state.");
  return value.map((input) => {
    const w = fields(input), ref = parseRequestUrl(String(fields(w.ref).url ?? ""));
    if (!ref || ref.service !== "github" || typeof w.threadId !== "string" || !w.threadId || !["watching", "unreadable", "ended"].includes(String(w.status)) || !Number.isFinite(w.startedAt) || !Number.isInteger(w.wakes) || !Number.isInteger(w.commentStreak) || Number(w.wakes) < 0 || Number(w.commentStreak) < 0) throw new HostCommandError("Invalid PR watch record.");
    const baseline = w.baseline as WatchSnapshot | undefined;
    if (baseline && (!["OPEN", "CLOSED", "MERGED"].includes(baseline.state) || typeof baseline.head !== "string" || typeof baseline.checks !== "string" || typeof baseline.comments !== "string" || typeof baseline.conflict !== "boolean")) throw new HostCommandError("Invalid PR watch snapshot.");
    return { threadId: w.threadId, ref, status: w.status as PullRequestWatch["status"], startedAt: w.startedAt as number, wakes: w.wakes as number, commentStreak: w.commentStreak as number, ...(typeof w.lastReadAt === "number" ? { lastReadAt: w.lastReadAt } : {}), ...(baseline ? { baseline } : {}), ...(typeof w.reason === "string" ? { reason: w.reason.slice(0, 400) } : {}), ...(w.stoppedBy === "user" || w.stoppedBy === "settle" ? { stoppedBy: w.stoppedBy } : {}) };
  });
}
/** Persistent watches feed visible, marked queue messages. They never steer a running turn or merge a PR. */
export async function registerPullRequestWatches(context: HostExtensionContext, sources: SourceControl, links: ThreadLinks, options: { period?: number; read?: typeof readWatchSnapshot; now?: () => number } = {}): Promise<() => Promise<void>> {
  const { services } = context, now = options.now ?? Date.now;
  const file = join(services.stateDir, "pr-watches.json");
  const stored = await readPersistedJson<PullRequestWatch[]>(file, { expectedVersion: 1, decode });
  const watches = new Map((stored?.data ?? []).map((watch) => [key(watch), watch]));
  let disposed = false, polling = false;
  let writes = Promise.resolve();
  const list = () => structuredClone([...watches.values()]);
  const changed = () => {
    const snapshot = list();
    const write = writes.then(() => writePersistedJson(file, 1, { watches: snapshot }));
    writes = write.catch(() => { disposed = true; for (const watch of watches.values()) { watch.status = "ended"; watch.reason = "Watch storage could not be saved"; } services.log("review.watch-storage", "PR watches stopped because their state could not be saved."); context.emit("pr-watches", list()); });
    context.emit("pr-watches", snapshot);
    return write;
  };
  const stop = async (threadId: string, by: "user" | "settle", url?: string) => {
    const stopped: string[] = [];
    for (const watch of watches.values()) if (watch.threadId === threadId && (!url || watch.ref.url === url) && watch.status !== "ended") {
      watch.status = "ended"; watch.stoppedBy = by; watch.reason = by === "settle" ? "Thread settled" : "Stopped by you"; stopped.push(`stopped watching PR #${watch.ref.number}`);
    }
    if (stopped.length) await changed();
    return stopped;
  };
  const start = async (threadId: string, url: string) => {
    if (disposed) throw new HostCommandError("PR watching is unavailable.");
    const ref = sources.forUrl(url)?.ref;
    if (!ref || ref.service !== "github") throw new HostCommandError("Watching is available for GitHub pull requests.");
    // `sessions.list` holds only Pi's own threads; the index has every runtime's.
    const index = await services.sessions.refreshIndex();
    if (index.type !== "thread-index" || !index.index.sessions.some((thread) => thread.id === threadId)) throw new HostCommandError("The thread no longer exists.");
    await links.link(threadId, ref.url, "user");
    const id = key({ threadId, ref });
    if (watches.get(id)?.status !== "ended" && watches.has(id)) return structuredClone(watches.get(id));
    if (!watches.has(id) && watches.size >= 100) {
      const ended = [...watches].find(([, watch]) => watch.status === "ended");
      if (!ended) throw new HostCommandError("At most 100 PR watches can run at once.");
      watches.delete(ended[0]);
    }
    const snapshot = await (options.read ?? readWatchSnapshot)(sources.tools, ref);
    if (snapshot.state !== "OPEN") throw new HostCommandError("This pull request is already closed or merged.");
    const watch: PullRequestWatch = { threadId, ref, status: "watching", startedAt: now(), lastReadAt: now(), wakes: 0, commentStreak: 0, baseline: snapshot };
    watches.set(id, watch); await changed(); return structuredClone(watch);
  };
  const wake = async (watch: PullRequestWatch, reasons: string[]) => {
    if (!services.sessions.send) throw new HostCommandError("The host cannot queue PR wakes.");
    await services.sessions.send(watch.threadId, `Pull request #${watch.ref.number} (${watch.ref.url}): ${reasons.join(", ")}. Inspect the current state and decide what work is needed. Merging stays with the user.`, { delivery: "queue", wake: { source: "pull-request", label: `PR #${watch.ref.number} · ${reasons.join(" · ")}` } });
  };
  const tick = async () => {
    if (disposed || polling || ![...watches.values()].some((watch) => watch.status !== "ended")) return;
    polling = true;
    const reads = new Map<string, Promise<WatchSnapshot>>();
    try {
      // All watches of one PR share its read, including ones that were added during this poll.
      for (const watch of [...watches.values()]) {
        if (disposed || watch.status === "ended") continue;
        try {
          let read = reads.get(watch.ref.url);
          if (!read) { read = (options.read ?? readWatchSnapshot)(sources.tools, watch.ref); reads.set(watch.ref.url, read); }
          // oxlint-disable-next-line no-await-in-loop -- bounded sequential admissions, one shared read per PR.
          const snapshot = await read;
          if (disposed || watch.stoppedBy || watches.get(key(watch)) !== watch) continue;
          const reasons = watch.baseline ? watchChanges(watch.baseline, snapshot) : [];
          watch.baseline = snapshot; watch.lastReadAt = now(); watch.status = "watching"; watch.reason = undefined;
          if (reasons.length) {
            watch.wakes++; watch.commentStreak = reasons.length === 1 && reasons[0] === "new comments or reviews" ? watch.commentStreak + 1 : 0;
            if (snapshot.state !== "OPEN" || watch.commentStreak >= 10) { watch.status = "ended"; watch.reason = snapshot.state !== "OPEN" ? `PR ${snapshot.state.toLowerCase()}` : "Ten consecutive comment wakes"; }
          }
          // Save the fingerprint before admission: restart never blindly replays a wake.
          // oxlint-disable-next-line no-await-in-loop
          if (reasons.length) await changed();
          if (reasons.length && !disposed && watch.stoppedBy !== "user" && watch.stoppedBy !== "settle") {
            // oxlint-disable-next-line no-await-in-loop
            await wake(watch, [...reasons, ...(watch.reason === "Ten consecutive comment wakes" ? ["watch ended after ten comment wakes"] : [])]).catch(async () => {
              watch.status = "ended"; watch.reason = "Wake admission was not confirmed. Inspect the thread before watching again."; await changed();
            });
          }
        } catch (error) {
          if (disposed || watch.stoppedBy) continue;
          watch.status = "unreadable"; watch.reason = message(error);
          const ended = now() - (watch.lastReadAt ?? watch.startedAt) >= UNREADABLE_LIMIT;
          if (ended) { watch.status = "ended"; watch.reason = "GitHub unreadable for 15 minutes"; }
          // oxlint-disable-next-line no-await-in-loop
          if (ended) await changed();
          if (ended) {
            // oxlint-disable-next-line no-await-in-loop
            await wake(watch, ["watch ended: GitHub unreadable for 15 minutes"]).catch(() => undefined);
          }
        }
      }
    } finally { polling = false; if (!disposed) await changed(); }
  };
  context.registerCommand("watch-list", () => ({ watches: list() }), { access: "read" });
  context.registerCommand("watch-start", (input) => { const v = fields(input); return start(String(v.threadId ?? ""), String(v.url ?? "")); }, { long: true, audit: { label: "started watching a pull request" } });
  context.registerCommand("watch-stop", async (input) => {
    const v = fields(input), threadId = String(v.threadId ?? ""), url = String(v.url ?? "");
    const watch = [...watches.values()].find((value) => value.threadId === threadId && value.ref.url === url);
    if (watch) { watch.status = "ended"; watch.stoppedBy = "user"; watch.reason = "Stopped by you"; await changed(); }
    return list();
  }, { audit: { label: "stopped watching a pull request" } });
  context.registerCommand("watch-shelf", async (input) => {
    const v = fields(input);
    await Promise.all((Array.isArray(v.settled) ? v.settled : []).map((id) => stop(String(id), "settle")));
    for (const id of Array.isArray(v.restored) ? v.restored : []) for (const watch of watches.values()) if (watch.threadId === id && watch.stoppedBy === "settle") { watch.status = "watching"; watch.stoppedBy = undefined; watch.reason = undefined; }
    await changed();
  }, { access: "owner", callers: [RAIL] });
  const tools = (session: RuntimeSessionInfo): HostMcpTool[] => [
    { name: "watch_pull_request", label: "Watch pull request", description: "Watch a GitHub PR in this thread. Queue a wake when checks finish, someone comments or reviews, the branch conflicts, or the PR closes. Never merges. Stops on Stop, Settle, ten consecutive comment wakes, or fifteen minutes without a readable host.", parameters: Type.Object({ url: Type.String() }), execute: async (_id, input) => { const watch = await start(session.sessionId, String(fields(input).url ?? "")); return { content: [{ type: "text", text: JSON.stringify(watch) }], details: watch }; } },
    { name: "unwatch_pull_request", label: "Stop watching pull request", description: "Stop this thread's PR watches. Does not stop its running turn.", parameters: Type.Object({ url: Type.Optional(Type.String()) }), execute: async (_id, input) => { const url = fields(input).url; const result = await stop(session.sessionId, "user", typeof url === "string" ? url : undefined); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; } },
  ];
  const disposers = [services.mcp.registerTools(tools), services.registerRuntimeExtension("tau-pull-request-watch", (pi, session) => { for (const tool of tools(session)) pi.registerTool(tool); pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${WATCH_INSTRUCTIONS}` })); }), services.mcp.registerInstructions?.(() => WATCH_INSTRUCTIONS) ?? (() => undefined), services.registerTurnObserver({ stopped: (id) => stop(id, "user") }), services.registerThreadLifecycle({ threadDeleted: async (id) => { for (const [watchKey, watch] of watches) if (watch.threadId === id) watches.delete(watchKey); await changed(); } })];
  const timer = setInterval(() => { void tick().catch((error) => services.log("review.watch", message(error))); }, options.period ?? PERIOD); timer.unref?.();
  void tick().catch((error) => services.log("review.watch", message(error)));
  return async () => { disposed = true; clearInterval(timer); for (const dispose of disposers.reverse()) dispose(); await writes; };
}
