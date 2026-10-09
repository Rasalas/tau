import { Type } from "typebox";
import { join } from "node:path";
import { HostCommandError, readPersistedJson, writePersistedJson, type HostExtensionContext, type HostMcpTool, type RuntimeSessionInfo } from "tau/host-extension";
import type { SourceControl } from "./provider-registry.js";
import type { ThreadLinks } from "./thread-links-host.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { readWatchSnapshot } from "./pr-watch-github.js";
import { watchChanges, watchStanding, type PullRequestWatch, type WatchSnapshot } from "./pr-watch-protocol.js";
const PERIOD = 60_000;
const UNREADABLE_LIMIT = 15 * 60_000;
const RAIL = "tau.thread-rail";
const fields = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 400);
const key = (watch: Pick<PullRequestWatch, "threadId" | "ref">) => `${watch.threadId}:${watch.ref.url}`;
/** In every runtime's system prompt, so an agent waits on a PR with a watch instead of a polling loop. */
export const WATCH_INSTRUCTIONS = `<pull_request_watching>
When your next step waits on a GitHub pull request, such as its checks finishing or a review arriving, call watch_pull_request with its full URL, tell the user, and end your turn. Watch every request you open or wait on, each layer of a stack included. Tau then sends a message into this thread, possibly while you are still working, when all checks finish or one fails, someone comments or reviews, the branch conflicts, or the request is merged or closed, and you continue from there. Do not wait with gh pr checks --watch, sleep or a background polling loop.
One message names every watched request that changed and where the thread's other watched requests stand. Handle all of them in that turn rather than one per turn.
A watch never merges or edits the request. Merge only when the user asked you to. An instruction such as "merge them once they are green" holds for every request it covers until the user withdraws it; follow it without asking again. Before you merge or close a watched request yourself, call unwatch_pull_request for it, so its end does not wake the thread. Call unwatch_pull_request when you no longer need a watch.
</pull_request_watching>`;
/** A baseline saved before failures were tracked held one combined `checks` string. */
function decodeSnapshot(value: unknown): WatchSnapshot {
  const b = fields(value);
  if (!["OPEN", "CLOSED", "MERGED"].includes(String(b.state)) || typeof b.head !== "string" || typeof b.checks !== "string" || typeof b.comments !== "string" || typeof b.conflict !== "boolean") throw new HostCommandError("Invalid PR watch snapshot.");
  const snapshot = { state: b.state as WatchSnapshot["state"], head: b.head, comments: b.comments, conflict: b.conflict };
  if (b.failed === undefined && !["none", "pending", "done"].includes(b.checks)) return { ...snapshot, checks: legacyChecks(b.checks) };
  if (!["none", "pending", "done"].includes(b.checks) || !Array.isArray(b.failed) || b.failed.length > 100 || !b.failed.every((check) => typeof fields(check).id === "string" && typeof fields(check).name === "string")) throw new HostCommandError("Invalid PR watch snapshot.");
  return { ...snapshot, checks: b.checks as WatchSnapshot["checks"], failed: b.failed.map((check) => ({ id: String(check.id), name: String(check.name).slice(0, 200) })) };
}
function legacyChecks(checks: string): WatchSnapshot["checks"] {
  if (checks === "NONE") return "none";
  let state: unknown = checks;
  try { state = (JSON.parse(checks) as unknown[])[0]; } catch { /* a bare rollup state */ }
  return state === "PENDING" || state === "EXPECTED" ? "pending" : "done";
}
export interface WatchEvent { watch: Pick<PullRequestWatch, "ref">; reasons: readonly string[]; snapshot?: WatchSnapshot }
/** Where the wake line cuts a label (`markWake`). */
const LABEL_LIMIT = 160;
/**
 * The label of one wake: a subject per PR, joined the way `combineWakes` reads them.
 * Too long for the line, it drops the check names, then everything but the numbers; the body keeps them.
 */
export function wakeLabel(events: readonly WatchEvent[]): string {
  const build = (short: (reason: string) => string) => events.map(({ watch, reasons }) => [`PR #${watch.ref.number}`, ...reasons.map(short)].join(" · ")).join("; ");
  for (const short of [(reason: string) => reason, (reason: string) => reason.replace(/ \(.*\)$/u, "")]) {
    const label = build(short);
    if (label.length <= LABEL_LIMIT) return label;
  }
  return events.map(({ watch }) => `PR #${watch.ref.number}`).join("; ");
}
/**
 * One wake for every PR of a thread that changed in a poll, then where its other watches stand.
 * Names the commit each event belongs to, so an agent that pushed since can tell a stale result from its own.
 */
export function wakeText(events: readonly WatchEvent[], others: readonly Pick<PullRequestWatch, "ref" | "baseline" | "status">[] = []): string {
  const parts = events.flatMap(({ watch, reasons, snapshot }) => {
    const at = snapshot ? ` at head commit ${snapshot.head}` : "";
    const jobs = (snapshot?.failed ?? []).filter((check) => /^\d+$/u.test(check.id)).map((check) => `${check.name}: job ${check.id} (gh run view --job ${check.id} --log-failed)`);
    return [`Pull request #${watch.ref.number} (${watch.ref.url})${at}: ${reasons.join(", ")}.`, ...(jobs.length ? [`Failed check runs on that commit:\n${jobs.map((job) => `- ${job}`).join("\n")}`] : [])];
  });
  const standing = others.map((watch) => `- #${watch.ref.number} (${watch.ref.url}): ${watch.status === "unreadable" ? "GitHub unreadable right now" : watchStanding(watch.baseline)}`);
  return [
    ...parts,
    ...(standing.length ? [`Other pull requests this thread watches, unchanged:\n${standing.join("\n")}`] : []),
    `${events.some((event) => event.snapshot) ? "If you pushed since, these results belong to the older commit. " : ""}Inspect the current state and decide what work is needed${events.length > 1 ? " for each of them in this turn" : ""}. The watch never merges; merge only when the user asked you to.`,
  ].join("\n\n");
}
function decode(value: unknown): PullRequestWatch[] {
  value = fields(value).watches;
  if (!Array.isArray(value) || value.length > 100) throw new HostCommandError("Invalid PR watch state.");
  return value.map((input) => {
    const w = fields(input), ref = parseRequestUrl(String(fields(w.ref).url ?? ""));
    if (!ref || ref.service !== "github" || typeof w.threadId !== "string" || !w.threadId || !["watching", "unreadable", "ended"].includes(String(w.status)) || !Number.isFinite(w.startedAt) || !Number.isInteger(w.wakes) || !Number.isInteger(w.commentStreak) || Number(w.wakes) < 0 || Number(w.commentStreak) < 0) throw new HostCommandError("Invalid PR watch record.");
    const baseline = w.baseline === undefined ? undefined : decodeSnapshot(w.baseline);
    return { threadId: w.threadId, ref, status: w.status as PullRequestWatch["status"], startedAt: w.startedAt as number, wakes: w.wakes as number, commentStreak: w.commentStreak as number, ...(typeof w.lastReadAt === "number" ? { lastReadAt: w.lastReadAt } : {}), ...(baseline ? { baseline } : {}), ...(typeof w.reason === "string" ? { reason: w.reason.slice(0, 400) } : {}), ...(w.stoppedBy === "user" || w.stoppedBy === "settle" ? { stoppedBy: w.stoppedBy } : {}) };
  });
}
/** Persistent watches send marked wakes; the host steers or queues them. They never merge a PR. */
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
  const wake = async (threadId: string, events: readonly WatchEvent[]) => {
    if (!services.sessions.send) throw new HostCommandError("The host cannot queue PR wakes.");
    const others = [...watches.values()].filter((watch) => watch.threadId === threadId && watch.status !== "ended" && !events.some((event) => event.watch === watch));
    await services.sessions.send(threadId, wakeText(events, others), { delivery: "queue", wake: { source: "pull-request", label: wakeLabel(events) } });
  };
  const tick = async () => {
    if (disposed || polling || ![...watches.values()].some((watch) => watch.status !== "ended")) return;
    polling = true;
    const reads = new Map<string, Promise<WatchSnapshot>>();
    const reread = new Set<string>();
    // A thread hears about every PR that changed in this poll in one wake, not one turn per PR.
    const due = new Map<string, (WatchEvent & { watch: PullRequestWatch; unreadable?: true })[]>();
    const add = (event: WatchEvent & { watch: PullRequestWatch; unreadable?: true }) => due.set(event.watch.threadId, [...due.get(event.watch.threadId) ?? [], event]);
    try {
      // All watches of one PR share its read, including ones that were added during this poll.
      for (const watch of [...watches.values()]) {
        if (disposed || watch.status === "ended") continue;
        try {
          let read = reads.get(watch.ref.url);
          if (!read) { read = (options.read ?? readWatchSnapshot)(sources.tools, watch.ref); reads.set(watch.ref.url, read); }
          // oxlint-disable-next-line no-await-in-loop -- bounded sequential reads, one shared read per PR.
          const snapshot = await read;
          if (disposed || watch.stoppedBy || watches.get(key(watch)) !== watch) continue;
          const reasons = watch.baseline ? watchChanges(watch.baseline, snapshot) : [];
          // The thread's link and strip learn a merge or push from the watch, not a minute later.
          if (watch.baseline && (watch.baseline.state !== snapshot.state || watch.baseline.head !== snapshot.head) && !reread.has(watch.ref.url)) {
            reread.add(watch.ref.url);
            void links.reread(watch.ref.url);
          }
          watch.baseline = snapshot; watch.lastReadAt = now(); watch.status = "watching"; watch.reason = undefined;
          if (!reasons.length) continue;
          watch.wakes++; watch.commentStreak = reasons.length === 1 && reasons[0] === "new comments or reviews" ? watch.commentStreak + 1 : 0;
          if (snapshot.state !== "OPEN" || watch.commentStreak >= 10) { watch.status = "ended"; watch.reason = snapshot.state !== "OPEN" ? `PR ${snapshot.state.toLowerCase()}` : "Ten consecutive comment wakes"; }
          add({ watch, reasons: [...reasons, ...(watch.reason === "Ten consecutive comment wakes" ? ["watch ended after ten comment wakes"] : [])], snapshot });
        } catch (error) {
          if (disposed || watch.stoppedBy) continue;
          watch.status = "unreadable"; watch.reason = message(error);
          if (now() - (watch.lastReadAt ?? watch.startedAt) < UNREADABLE_LIMIT) continue;
          watch.status = "ended"; watch.reason = "GitHub unreadable for 15 minutes";
          add({ watch, reasons: ["watch ended: GitHub unreadable for 15 minutes"], unreadable: true });
        }
      }
      // Save the fingerprints before admission: restart never blindly replays a wake.
      if (due.size) await changed();
      for (const [threadId, events] of due) {
        const live = events.filter((event) => !event.watch.stoppedBy && watches.get(key(event.watch)) === event.watch);
        if (disposed || !live.length) continue;
        // oxlint-disable-next-line no-await-in-loop -- one admission per thread, in order.
        await wake(threadId, live).catch(async () => {
          // An unreadable watch has already ended with its own reason.
          for (const event of live) if (!event.unreadable) { event.watch.status = "ended"; event.watch.reason = "Wake admission was not confirmed. Inspect the thread before watching again."; }
          await changed();
        });
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
    { name: "watch_pull_request", label: "Watch pull request", description: "Watch a GitHub PR in this thread; watch each PR you wait on. Wake the thread when all checks finish or one fails, someone comments or reviews, the branch conflicts, or the PR closes; one wake covers every watched PR that changed. Never merges. Stops on Stop, Settle, ten consecutive comment wakes, or fifteen minutes without a readable host.", parameters: Type.Object({ url: Type.String() }), execute: async (_id, input) => { const watch = await start(session.sessionId, String(fields(input).url ?? "")); return { content: [{ type: "text", text: JSON.stringify(watch) }], details: watch }; } },
    { name: "unwatch_pull_request", label: "Stop watching pull request", description: "Stop this thread's PR watches: the named URL, or all of them without one. Call it before you merge or close a watched PR yourself. Does not stop its running turn.", parameters: Type.Object({ url: Type.Optional(Type.String()) }), execute: async (_id, input) => { const url = fields(input).url; const result = await stop(session.sessionId, "user", typeof url === "string" ? url : undefined); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; } },
  ];
  const disposers = [services.mcp.registerTools(tools), services.registerRuntimeExtension("tau-pull-request-watch", (pi, session) => { for (const tool of tools(session)) pi.registerTool(tool); pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${WATCH_INSTRUCTIONS}` })); }), services.mcp.registerInstructions?.(() => WATCH_INSTRUCTIONS) ?? (() => undefined), services.registerTurnObserver({ stopped: (id) => stop(id, "user") }), services.registerThreadLifecycle({ threadDeleted: async (id) => { for (const [watchKey, watch] of watches) if (watch.threadId === id) watches.delete(watchKey); await changed(); } })];
  const timer = setInterval(() => { void tick().catch((error) => services.log("review.watch", message(error))); }, options.period ?? PERIOD); timer.unref?.();
  void tick().catch((error) => services.log("review.watch", message(error)));
  return async () => { disposed = true; clearInterval(timer); for (const dispose of disposers.reverse()) dispose(); await writes; };
}
