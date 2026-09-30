import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { HostCommandError, type HostExtensionContext, type UiMessage } from "tau/host-extension";
import {
  LOCAL_REVIEWS_EVENT,
  noteRequest,
  rebaseRequest,
  remoteReviewKey,
  reviewKey,
  type LocalReviewsAnswer,
  type MergedReview,
  type RemoteReview,
  type ReviewAsk,
  type ThreadBranch,
  type ThreadBranchMerge,
} from "./local-reviews.js";
import type { ReviewRequestContext } from "./protocol.js";

const FILE = "local-reviews.json";
const REMOTE_WORK = "tau.remote-work";

/** Remote Work's link and preview, mirrored: the part Reviews reads. */
interface RemoteLink {
  id: string;
  machineName: string;
  root: string;
  title?: string;
  parentThreadId?: string;
  backend?: string;
  model?: { provider: string; id: string };
  transfer?: string;
  status: string;
  usage?: { costUsd?: number };
  result?: { state: "nothing" } | { state: "branch"; branch: string; tip: string; commits: number; files: number; paths?: string[] };
  applied?: { state: string; detail: string; files: string[]; commit?: string };
  updatedAt: number;
}
interface TransferPreview { conflicts: string[]; merged: boolean }
/** A link in these states is not done, or not ours to merge any more. */
const REMOTE_BUSY = new Set(["sending", "starting", "running", "waiting", "offline", "settled", "gone"]);
/** Merges the book keeps; the oldest go. */
const MAX_MERGED = 500;
const SUMMARY_CHARS = 1200;

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const required = (input: unknown, key: string): string => {
  const value = text(record(input)[key]);
  if (!value) throw new HostCommandError(`Reviews needs "${key}".`);
  return value;
};

interface Book {
  asks: Record<string, ReviewAsk>;
  merged: MergedReview[];
}

/** Asks and merges, in the kit's own state folder, written whole through a temporary file. */
export class LocalReviewBook {
  private book: Book | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly stateDir: string) {}

  async read(): Promise<Book> {
    if (this.book) return this.book;
    try {
      const raw = record(JSON.parse(await readFile(join(this.stateDir, FILE), "utf8")));
      const asks = Object.fromEntries(Object.entries(record(raw.asks)).filter(([, ask]) => {
        const fields = record(ask);
        return (fields.kind === "rebase" || fields.kind === "note") && typeof fields.tip === "string" && typeof fields.text === "string";
      })) as Record<string, ReviewAsk>;
      const merged = (Array.isArray(raw.merged) ? raw.merged : []).filter((entry): entry is MergedReview => typeof record(entry).key === "string" && typeof record(entry).at === "number");
      this.book = { asks, merged };
    } catch {
      this.book = { asks: {}, merged: [] };
    }
    return this.book;
  }

  async change(edit: (book: Book) => void): Promise<Book> {
    const book = await this.read();
    edit(book);
    book.merged = book.merged.sort((left, right) => right.at - left.at).slice(0, MAX_MERGED);
    const snapshot = JSON.stringify({ version: 1, ...book }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(this.stateDir, { recursive: true });
      const temporary = join(this.stateDir, `${FILE}.${process.pid}.tmp`);
      await writeFile(temporary, snapshot);
      await rename(temporary, join(this.stateDir, FILE));
    }).catch(() => undefined);
    await this.writing;
    return book;
  }
}

/** The last answer of a Pi session's entries, and how many prompts it had. */
export function summaryFromEntries(entries: readonly unknown[]): { summary?: string; turns: number } {
  let turns = 0;
  let summary: string | undefined;
  for (const entry of entries) {
    const message = record(record(entry).message);
    if (record(entry).type !== "message") continue;
    if (message.role === "user") turns += 1;
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const said = message.content.map(record).filter((part) => part.type === "text").map((part) => text(part.text) ?? "").join("\n").trim();
    if (said) summary = said;
  }
  return { ...(summary ? { summary: clip(summary) } : {}), turns };
}

function summaryFromMessages(messages: readonly UiMessage[]): { summary?: string; turns: number } {
  const turns = messages.filter((message) => message.role === "user").length;
  const said = [...messages].reverse().find((message) => message.role === "assistant" && message.text.trim())?.text.trim();
  return { ...(said ? { summary: clip(said) } : {}), turns };
}

const clip = (value: string) => value.length > SUMMARY_CHARS ? `${value.slice(0, SUMMARY_CHARS).trimEnd()}…` : value;

/**
 * The Reviews page's host commands. Git is Workspace Kit's: the branches and
 * the merge (`merge-tree` first, then `merge --no-ff`) go through its
 * `thread-branches` and `merge-thread-branch` (callers `tau.review`). This
 * side keeps what Git does not know: the asks sent back to a thread and the
 * merges made from the page, with what the thread cost.
 */
export function registerLocalReviewCommands(
  context: HostExtensionContext,
  workspace: (command: string, input?: unknown) => Promise<unknown>,
  requestMerged?: (threadIds: readonly string[], branch: string) => Promise<boolean>,
): void {
  const { services } = context;
  const book = new LocalReviewBook(services.stateDir);
  const changed = () => context.emit(LOCAL_REVIEWS_EVENT, {});

  /** Git's answer, with the branches whose linked pull request is known to have merged on the host. */
  const readBranches = async (workspaces: string[]): Promise<ThreadBranch[]> => {
    const branches = workspaces.length ? await workspace("thread-branches", { workspaces }) as ThreadBranch[] : [];
    const open = branches.filter((branch) => !branch.merged && branch.ahead > 0);
    if (!requestMerged || open.length === 0) return branches;
    const sessions = await services.sessions.list().catch(() => []);
    const inside = (path: string, cwd: string) => cwd === path || cwd.startsWith(`${path}${sep}`);
    return Promise.all(branches.map(async (branch) => {
      if (!open.includes(branch)) return branch;
      const ids = sessions.filter((session) => inside(branch.path, session.cwd)).map((session) => session.sessionId);
      return ids.length && await requestMerged(ids, branch.branch).catch(() => false) ? { ...branch, merged: true, mergedBy: "request" as const, conflicts: [] } : branch;
    }));
  };

  const remoteWork = (command: string, input: unknown) => context.invokeHostExtension(REMOTE_WORK, command, input);
  /** Threads on other machines whose work came back as a branch here and is not merged; none without Remote Work. */
  const remoteReviews = async (): Promise<RemoteReview[]> => {
    const links = await remoteWork("threads", { active: true }).catch(() => []) as RemoteLink[];
    const back = (Array.isArray(links) ? links : []).filter((link) => link.result?.state === "branch" && link.transfer && !REMOTE_BUSY.has(link.status)
      && link.applied?.state !== "merged" && link.applied?.state !== "already-merged");
    const targets = new Map<string, Promise<string | undefined>>();
    const targetOf = (root: string) => {
      if (!targets.has(root)) targets.set(root, workspace("review-request-context", { workspace: root }).then((git) => (git as ReviewRequestContext).branch, () => undefined));
      return targets.get(root)!;
    };
    return Promise.all(back.map(async (link): Promise<RemoteReview> => {
      const result = link.result as Extract<RemoteLink["result"], { state: "branch" }>;
      const [preview, target] = await Promise.all([
        remoteWork("preview", { transfer: link.transfer }).catch(() => undefined) as Promise<TransferPreview | undefined>,
        targetOf(link.root),
      ]);
      return {
        link: link.id,
        machine: link.machineName,
        root: link.root,
        rootWorkspace: services.workspaceRef(link.root).workspaceId,
        ...(target ? { target } : {}),
        ...(link.title ? { title: link.title } : {}),
        ...(link.parentThreadId ? { threadId: link.parentThreadId } : {}),
        branch: result.branch,
        tip: result.tip,
        commits: result.commits,
        files: result.files,
        paths: result.paths ?? [],
        conflicts: preview?.conflicts ?? [],
        merged: preview?.merged ?? false,
        ...(link.model ? { modelProvider: link.model.provider, model: link.model.id } : {}),
        ...(link.backend ? { backend: link.backend } : {}),
        ...(typeof link.usage?.costUsd === "number" ? { costUsd: link.usage.costUsd } : {}),
        at: link.updatedAt,
      };
    }));
  };

  context.registerCommand("local-reviews", async (input): Promise<LocalReviewsAnswer> => {
    const workspaces = (Array.isArray(record(input).workspaces) ? record(input).workspaces as unknown[] : []).filter((id): id is string => typeof id === "string");
    const branches = await readBranches(workspaces);
    const tips = new Map(branches.map((branch) => [reviewKey(branch.root, branch.branch), branch.tip]));
    const current = await book.read();
    // An ask is answered once the branch moves.
    const remote = await remoteReviews();
    for (const entry of remote) tips.set(remoteReviewKey(entry.link), entry.tip);
    const stale = Object.entries(current.asks).filter(([key, ask]) => tips.has(key) && tips.get(key) !== ask.tip).map(([key]) => key);
    const kept = stale.length ? await book.change((next) => { for (const key of stale) delete next.asks[key]; }) : current;
    return { branches, asks: { ...kept.asks }, merged: [...kept.merged], remote };
  }, { access: "read", long: true });

  /** Remote Work merges the branch that came back (`merge-tree`, then `merge --no-ff`) and lets the worktree there go. */
  const mergeRemote = async (link: string, fields: Record<string, unknown>): Promise<ThreadBranchMerge> => {
    const settled = await remoteWork("thread-settle", { link, how: "apply" }) as RemoteLink;
    const applied = settled.applied;
    const state = (applied?.state ?? (settled.status === "settled" ? "merged" : "blocked")) as ThreadBranchMerge["state"];
    const branch = settled.result?.state === "branch" ? settled.result.branch : text(fields.branch) ?? link;
    return { branch, state, files: applied?.files ?? [], detail: applied?.detail ?? "", into: text(fields.target) ?? "", root: settled.root, ...(applied?.commit ? { commit: applied.commit } : {}) };
  };

  context.registerCommand("local-review-merge", async (input) => {
    const fields = record(input);
    const link = text(fields.link);
    const outcome = link
      ? await mergeRemote(link, fields)
      : await workspace("merge-thread-branch", { workspace: required(input, "workspace"), ...(text(fields.tip) ? { tip: text(fields.tip) } : {}) }) as ThreadBranchMerge;
    if (outcome.state !== "merged" && outcome.state !== "already-merged") return outcome;
    const key = link ? remoteReviewKey(link) : reviewKey(outcome.root, outcome.branch);
    await book.change((next) => {
      delete next.asks[key];
      next.merged = next.merged.filter((entry) => entry.key !== key);
      next.merged.push({
        key,
        root: outcome.root,
        branch: outcome.branch,
        target: outcome.into,
        ...(text(fields.workspace) ? { workspace: text(fields.workspace) } : {}),
        ...(text(fields.rootWorkspace) ? { rootWorkspace: text(fields.rootWorkspace) } : {}),
        ...(text(fields.threadId) ? { threadId: text(fields.threadId) } : {}),
        title: text(fields.title) ?? outcome.branch,
        ...(text(fields.project) ? { project: text(fields.project) } : {}),
        ...(outcome.commit ? { commit: outcome.commit } : {}),
        at: Date.now(),
        files: number(fields.files) ?? 0,
        added: number(fields.added) ?? 0,
        removed: number(fields.removed) ?? 0,
        ...(number(fields.costUsd) !== undefined ? { costUsd: number(fields.costUsd) } : {}),
        ...(text(fields.modelProvider) ? { modelProvider: text(fields.modelProvider) } : {}),
        ...(text(fields.model) ? { model: text(fields.model) } : {}),
      });
    });
    services.log("reviews.merged", `${outcome.branch} into ${outcome.into}`);
    changed();
    return outcome;
  }, { long: true, audit: { label: "merged a thread's branch from Reviews" } });

  // A merged branch's worktree and branch go; its threads and any merge record stay.
  context.registerCommand("local-review-remove", async (input) => {
    const named = required(input, "workspace");
    const [branch] = await readBranches([named]);
    if (!branch) throw new HostCommandError("This worktree is gone already.");
    const removed = await workspace("remove-thread-branch", { workspace: named, ...(branch.mergedBy === "request" ? { requestMerged: true } : {}) }) as { branch: string };
    services.log("reviews.removed", removed.branch);
    changed();
    return removed;
  }, { long: true, audit: { label: "removed a merged branch and its worktree from Reviews" } });

  // The thread gets the ask as the user's next message; the row shows it until the branch moves.
  context.registerCommand("local-review-ask", async (input) => {
    const fields = record(input);
    const kind = fields.kind === "note" ? "note" : fields.kind === "rebase" ? "rebase" : undefined;
    if (!kind) throw new HostCommandError('Reviews asks for "rebase" or "note".');
    const link = text(fields.link);
    const threadId = link ? undefined : required(input, "threadId");
    const branch = required(input, "branch");
    const target = text(fields.target) ?? "the target branch";
    const note = kind === "note" ? required(input, "text") : "";
    const conflicts = (Array.isArray(fields.conflicts) ? fields.conflicts : []).filter((path): path is string => typeof path === "string");
    const message = kind === "rebase" ? rebaseRequest({ branch, target, conflicts }) : noteRequest({ branch }, note);
    if (link) {
      await remoteWork("thread-send", { link, text: message, delivery: "prompt" });
    } else {
      const send = services.sessions.send;
      if (!send) throw new HostCommandError("This Tau cannot send to another thread.");
      await send(threadId!, message, { delivery: "prompt" });
    }
    const key = link ? remoteReviewKey(link) : reviewKey(required(input, "root"), branch);
    await book.change((next) => {
      next.asks[key] = { kind, text: kind === "note" ? note.trim() : message, at: Date.now(), tip: required(input, "tip"), ...(threadId ? { threadId } : {}) };
    });
    services.log("reviews.asked", `${kind} ${branch}`);
    changed();
  }, { long: true, audit: { label: "sent a review back to a thread" } });

  context.registerCommand("local-review-withdraw", async (input) => {
    const link = text(record(input).link);
    const key = link ? remoteReviewKey(link) : reviewKey(required(input, "root"), required(input, "branch"));
    await book.change((next) => { delete next.asks[key]; });
    changed();
  });

  context.registerCommand("local-review-summary", async (input): Promise<{ summary?: string; turns?: number }> => {
    const fields = record(input);
    const threadId = text(fields.threadId);
    let found: { summary?: string; turns: number } | undefined;
    const open = threadId ? services.thread(threadId) : undefined;
    if (open) found = summaryFromMessages(await open.transcript().catch(() => []));
    if (!found?.summary && threadId) {
      const session = (await services.sessions.list().catch(() => [])).find((entry) => entry.sessionId === threadId);
      if (session) {
        try { found = summaryFromEntries(services.sessions.open(session.path).entries()); } catch { /* unreadable: the commit below */ }
      }
    }
    if (found?.summary) return found;
    // A thread whose runtime keeps its own history: the newest commit says what it did.
    const named = text(fields.workspace);
    if (!named) return found ?? {};
    const git = await workspace("review-request-context", { workspace: named, detail: true, ...(text(fields.target) ? { base: text(fields.target) } : {}) }).catch(() => undefined) as ReviewRequestContext | undefined;
    const commit = git?.commits?.[0];
    const said = commit ? [commit.subject, commit.body].filter((part) => part?.trim()).join("\n\n").trim() : "";
    return { ...(said ? { summary: clip(said) } : {}), ...(found ? { turns: found.turns } : {}) };
  }, { access: "read", long: true });
}
