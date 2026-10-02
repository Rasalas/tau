import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type {
  MergeMethod,
  PendingReviewComment,
  PullRequestAction,
  PullRequestActionResult,
  PullRequestCheck,
  PullRequestDetail,
  PullRequestFiles,
  PullRequestLabel,
  PullRequestRef,
  PullRequestReviewEvent,
  PullRequestStack,
  PullRequestStackLayer,
  PullRequestStackMembership,
  PullRequestThread,
  PullRequestViewedState,
} from "./protocol.js";
import { asReviewRequest } from "./pull-request-logic.js";
import type { ChangedFileEntry, SourceControlProvider } from "./provider.js";
import type { SourceControl } from "./provider-registry.js";
import { diffFingerprint } from "./pull-request-json.js";
import { LocalViewedStore } from "./pull-request-viewed.js";
import type { PipelineFacts } from "./pipeline.js";

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const names = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean))] : [];

export interface PullRequestCommandOptions {
  now?(): number;
  /** A revert opened a request on behalf of a thread; its URL. */
  created?(url: string, threadId: string | undefined): void;
}

/** The view's cached read of a request, for the kit's other commands (a link's snapshot). */
export interface PullRequestReads {
  detail(ref: PullRequestRef, fresh: boolean): Promise<PullRequestDetail>;
  /** The stack a request is a layer of; undefined for one on its own or a host without stacks. */
  stackOf?(ref: PullRequestRef): Promise<PullRequestStackMembership | undefined>;
}

const VERDICTS: Record<PullRequestReviewEvent, string> = { comment: "review without a verdict", approve: "approval", "request-changes": "request for changes" };

/**
 * The pull-request view's host half: one request, addressed by its URL, read
 * and written through the provider that serves it. Reads are cached per
 * request for a minute and every write drops that request's cache, so the
 * view's next read shows what the write did. A step the provider cannot take
 * is refused in words; the desktop hides it in the first place.
 */
export function registerPullRequestCommands(context: HostExtensionContext, sources: SourceControl, options: PullRequestCommandOptions = {}): PullRequestReads {
  const { services } = context;
  const now = options.now ?? Date.now;
  const { tools } = sources;
  const viewedStore = new LocalViewedStore(services.stateDir, now);

  const target = (input: unknown): { ref: PullRequestRef; provider: SourceControlProvider } => {
    const url = text(record(input).url);
    const found = url ? sources.forUrl(url) : undefined;
    if (!found) throw new HostCommandError("Name a pull or merge request by its URL.");
    return found;
  };

  const forget = (ref: PullRequestRef) => tools.forget(ref);

  const noun = (ref: PullRequestRef, provider: SourceControlProvider) => `${provider.info.short} #${ref.number}`;
  const lacks = (provider: SourceControlProvider, what: string) => new HostCommandError(`${provider.info.name} does not let Tau ${what}; do it on the website.`);

  const detail = (ref: PullRequestRef, fresh: boolean) => tools.cached("view", ref, fresh, async (): Promise<PullRequestDetail> => {
    const provider = sources.get(ref.service);
    const viewer = sources.viewer(ref.service, ref.host);
    const read = await provider.detail(ref, fresh);
    const login = await viewer;
    return login ? { ...read, viewer: login } : read;
  });

  const threads = (ref: PullRequestRef, provider: SourceControlProvider, fresh: boolean): Promise<PullRequestThread[]> =>
    provider.info.capabilities.conversations ? provider.threads(ref, fresh) : Promise.resolve([]);

  const changes = (ref: PullRequestRef, provider: SourceControlProvider, fresh: boolean): Promise<ChangedFileEntry[]> => {
    const read = provider.changes;
    if (!read) throw lacks(provider, "read a request's diff");
    return tools.cached("diff", ref, fresh, () => read(ref, fresh));
  };

  const files = async (ref: PullRequestRef, provider: SourceControlProvider, fresh: boolean): Promise<PullRequestFiles> => {
    const entries = await changes(ref, provider, fresh);
    const states: Map<string, PullRequestViewedState> = provider.viewedMarks
      ? await provider.viewedMarks.states(ref, fresh)
      : await viewedStore.states(ref.url, new Map(entries.map((entry) => [entry.file.path, diffFingerprint(entry.diff)])));
    return {
      files: entries.map((entry) => ({ ...entry.file, viewed: states.get(entry.file.path) ?? "unviewed" })),
      diffs: entries.map((entry) => entry.diff),
      viewedOn: provider.viewedMarks ? "host" : "local",
    };
  };

  const fresh = (input: unknown) => record(input).fresh === true;

  /** A write, then the cache it made stale goes, and the log says what happened. */
  const write = async (ref: PullRequestRef, provider: SourceControlProvider, step: () => Promise<void>, log: string) => {
    await step();
    forget(ref);
    services.log(log, noun(ref, provider));
  };

  context.registerCommand("pr-view", (input) => detail(target(input).ref, fresh(input)), { access: "read", long: true });

  context.registerCommand("pr-checks", async (input): Promise<PullRequestCheck[]> => {
    const { ref, provider } = target(input);
    // Checks move on their own, so they are never served from the cache.
    return provider.info.capabilities.checks ? provider.checks(ref) : [];
  }, { access: "read" });

  context.registerCommand("pr-pipeline", async (input): Promise<PipelineFacts> => {
    const { ref, provider } = target(input);
    const workflows = Object.entries(record(record(input).names)).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]));
    return provider.pipeline ? provider.pipeline(ref, names(record(input).runs), workflows.length ? Object.fromEntries(workflows) : undefined) : {};
  }, { access: "read", long: true });

  context.registerCommand("pr-comments", (input) => {
    const { ref, provider } = target(input);
    return threads(ref, provider, fresh(input));
  }, { access: "read", long: true });

  context.registerCommand("pr-files", (input) => {
    const { ref, provider } = target(input);
    return files(ref, provider, fresh(input));
  }, { access: "read", long: true });

  context.registerCommand("pr-comment", async (input) => {
    const { ref, provider } = target(input);
    const fields = record(input);
    const body = text(fields.body)?.trim();
    if (!body) throw new HostCommandError("Write a comment first.");
    const threadId = text(fields.threadId);
    const path = text(fields.path);
    const line = typeof fields.line === "number" && Number.isInteger(fields.line) && fields.line > 0 ? fields.line : undefined;
    if (threadId) {
      if (!provider.reply) throw lacks(provider, "reply to a conversation");
      await provider.reply(ref, threadId, body);
    } else if (path && line !== undefined) {
      if (!provider.lineComment) throw lacks(provider, "comment on a line");
      await provider.lineComment(ref, { path, line, body, side: fields.side === "old" ? "old" : "new" }, await detail(ref, false));
    } else {
      await provider.comment(ref, body);
    }
    forget(ref);
    services.log("request.commented", `${noun(ref, provider)}${threadId ? " · reply" : path ? ` · ${path}:${line}` : ""}`);
    return { ok: true };
  }, { long: true });

  context.registerCommand("pr-update", async (input): Promise<PullRequestDetail> => {
    const { ref, provider } = target(input);
    const fields = record(input);
    const title = text(fields.title)?.trim();
    const body = text(fields.body);
    if (text(fields.title) !== undefined && !title) throw new HostCommandError("A title is required.");
    if (title === undefined && body === undefined) throw new HostCommandError("Nothing to change.");
    if (!provider.info.capabilities.edit) throw lacks(provider, "edit a request");
    await write(ref, provider, () => provider.update(ref, { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) }), "request.edited");
    return detail(ref, true);
  }, { long: true });

  context.registerCommand("pr-viewed", async (input): Promise<{ viewed: PullRequestViewedState }> => {
    const { ref, provider } = target(input);
    const fields = record(input);
    const path = text(fields.path);
    if (!path) throw new HostCommandError("Name the file to mark.");
    const viewed = fields.viewed === true;
    if (provider.viewedMarks) {
      await provider.viewedMarks.set(ref, path, viewed, () => detail(ref, false));
    } else {
      const entry = (await changes(ref, provider, false)).find((candidate) => candidate.file.path === path);
      if (!entry) throw new HostCommandError(`${path} is not part of ${noun(ref, provider)}.`);
      await viewedStore.set(ref.url, path, diffFingerprint(entry.diff), viewed);
    }
    return { viewed: viewed ? "viewed" : "unviewed" };
  }, { long: true });

  /**
   * A review in one step: the verdict, its text and
   * every line comment held for it; the provider decides how its host takes them.
   */
  context.registerCommand("pr-review", async (input): Promise<PullRequestDetail> => {
    const { ref, provider } = target(input);
    const fields = record(input);
    const event = (["comment", "approve", "request-changes"] as const).find((candidate) => candidate === fields.event) as PullRequestReviewEvent | undefined;
    if (!event) throw new HostCommandError("Choose comment, approve or request changes.");
    const body = text(fields.body)?.trim() ?? "";
    const comments: PendingReviewComment[] = (Array.isArray(fields.comments) ? fields.comments : []).map(record).flatMap((comment) => {
      const path = text(comment.path);
      const line = typeof comment.line === "number" && Number.isInteger(comment.line) && comment.line > 0 ? comment.line : undefined;
      const commentBody = text(comment.body)?.trim();
      return path && line !== undefined && commentBody ? [{ id: text(comment.id) ?? "", path, line, side: comment.side === "old" ? "old" as const : "new" as const, body: commentBody }] : [];
    });
    if (event !== "approve" && !body && comments.length === 0) throw new HostCommandError(event === "comment" ? "Write a comment or add line comments first." : "Say what has to change.");
    if (!provider.info.capabilities.reviewEvents.includes(event)) throw new HostCommandError(`${provider.info.name} takes no ${VERDICTS[event]} through its API; comment instead.`);
    await provider.review(ref, { event, body, comments }, await detail(ref, false));
    forget(ref);
    services.log("request.reviewed", `${noun(ref, provider)} · ${event}${comments.length ? ` · ${comments.length} line comments` : ""}`);
    return detail(ref, true);
  }, { long: true });

  context.registerCommand("pr-resolve", async (input) => {
    const { ref, provider } = target(input);
    const fields = record(input);
    const threadId = text(fields.threadId);
    if (!threadId) throw new HostCommandError("Name the conversation.");
    const resolved = fields.resolved !== false;
    const resolve = provider.resolve;
    if (!resolve) throw lacks(provider, "resolve a conversation");
    await write(ref, provider, () => resolve(ref, threadId, resolved), resolved ? "request.resolved" : "request.unresolved");
    return threads(ref, provider, true);
  }, { long: true });

  context.registerCommand("pr-edit-comment", async (input) => {
    const { ref, provider } = target(input);
    const fields = record(input);
    const id = text(fields.id);
    const body = text(fields.body)?.trim();
    const kind = (["comment", "review", "review-comment"] as const).find((candidate) => candidate === fields.kind);
    if (!id || !kind) throw new HostCommandError("Name the comment to edit.");
    if (!body) throw new HostCommandError("A comment cannot be empty.");
    const edit = provider.editComment;
    if (!edit || !provider.info.capabilities.editComments.includes(kind)) throw lacks(provider, "edit this comment");
    await write(ref, provider, () => edit(ref, { id, kind, body }), "request.comment-edited");
    return { ok: true };
  }, { long: true });

  context.registerCommand("pr-reviewers", async (input): Promise<PullRequestDetail> => {
    const { ref, provider } = target(input);
    const add = names(record(input).add);
    const remove = names(record(input).remove);
    if (add.length === 0 && remove.length === 0) throw new HostCommandError("Nothing to change.");
    const change = provider.reviewers;
    if (!change) throw lacks(provider, "change the reviewers");
    await write(ref, provider, () => change(ref, add, remove), "request.reviewers");
    return detail(ref, true);
  }, { long: true });

  context.registerCommand("pr-labels", async (input): Promise<PullRequestDetail> => {
    const { ref, provider } = target(input);
    const add = names(record(input).add);
    const remove = names(record(input).remove);
    if (add.length === 0 && remove.length === 0) throw new HostCommandError("Nothing to change.");
    const change = provider.labels;
    if (!change) throw lacks(provider, "change the labels");
    await write(ref, provider, () => change(ref, add, remove), "request.labels");
    return detail(ref, true);
  }, { long: true });

  /** The repository's labels and the accounts that can review, for the pickers; either may come back empty. */
  context.registerCommand("pr-candidates", async (input): Promise<{ labels: PullRequestLabel[]; reviewers: string[] }> => {
    const { ref, provider } = target(input);
    const read = provider.candidates;
    if (!read) return { labels: [], reviewers: [] };
    return tools.cached("candidates", ref, fresh(input), () => read(ref));
  }, { access: "read", long: true });

  const methodOf = (value: unknown): MergeMethod | undefined => (["squash", "merge", "rebase"] as const).find((candidate) => candidate === value);

  /**
   * Merge, auto-merge and revert on a request opened by its URL: the view's
   * header offers them where the provider can, and a refusal says why.
   */
  context.registerCommand("pr-action", async (input): Promise<PullRequestActionResult> => {
    const { ref, provider } = target(input);
    const fields = record(input);
    const action = (["merge", "auto-merge", "cancel-auto-merge", "revert"] as const).find((candidate) => candidate === fields.action) as PullRequestAction | undefined;
    if (!action) throw new HostCommandError("Choose merge, auto-merge or revert.");
    const { capabilities, name } = provider.info;
    const deleteBranch = fields.deleteBranch === true && capabilities.deleteBranch;
    const method = methodOf(fields.method);
    // What the provider cannot do is refused before the host is asked anything.
    const revert = provider.revert;
    const arm = provider.autoMerge;
    if (action === "revert" && (!revert || !capabilities.revert)) throw lacks(provider, "revert a request");
    if (action !== "revert" && action !== "merge" && (!arm || !capabilities.autoMerge)) throw lacks(provider, "merge automatically");
    if (action === "merge" && (!method || !capabilities.merge.includes(method))) {
      throw new HostCommandError(capabilities.merge.length === 0 ? `${name} does not let Tau merge; merge it on the website.` : `Choose ${capabilities.merge.join(", ")}.`);
    }
    if (action === "auto-merge" && method && !capabilities.merge.includes(method)) throw new HostCommandError(`Choose ${capabilities.merge.join(", ")}.`);
    const known = await detail(ref, true);
    const request = asReviewRequest(known, []);
    const where = { host: ref.host, repo: ref.repo };
    if (action === "revert") {
      if (known.state !== "merged") throw new HostCommandError(`${noun(ref, provider)} is ${known.state}; only a merged one can be reverted.`);
      const created = await revert!(ref, known);
      forget(ref);
      services.log("request.reverted", `${noun(ref, provider)}${created ? ` · ${created}` : ""}`);
      if (created) options.created?.(created, text(fields.threadId));
      return { detail: await detail(ref, true), ...(created ? { created } : {}) };
    }
    if (known.state !== "open") throw new HostCommandError(`${noun(ref, provider)} is ${known.state}.`);
    if (action === "merge") {
      const outcome = await provider.merge(where, request, method!, { deleteBranch });
      forget(ref);
      services.log("request.merged", `${noun(ref, provider)} · ${method}${outcome?.branchDeleted ? " · branch deleted" : ""}`);
      return { detail: await detail(ref, true), ...(outcome ? { merge: outcome } : {}) };
    }
    await arm!(where, request, action === "auto-merge", method, { deleteBranch });
    forget(ref);
    services.log(action === "auto-merge" ? "request.auto-merge" : "request.auto-merge-off", noun(ref, provider));
    return { detail: await detail(ref, true) };
  }, { long: true });

  /** The stack a request is a layer of; null for one on its own or a host without stacks. */
  context.registerCommand("pr-stack", async (input): Promise<PullRequestStack | null> => {
    const { ref, provider } = target(input);
    const read = provider.stack;
    if (!read || !provider.info.capabilities.stacks) return null;
    return await read(ref, fresh(input)) ?? null;
  }, { access: "read", long: true });

  context.registerCommand("pr-stack-action", async (input): Promise<PullRequestDetail> => {
    const { ref, provider } = target(input);
    const fields = record(input);
    const action = (["merge", "rebase"] as const).find((candidate) => candidate === fields.action);
    if (!action) throw new HostCommandError("Choose to merge or to rebase the stack.");
    const act = provider.stackAction;
    if (!act || !provider.info.capabilities.stacks) throw lacks(provider, "act on a stack");
    const seen = decodeStack(fields.seen);
    if (!seen) throw new HostCommandError("Refresh the stack before acting on it.");
    const method = methodOf(fields.method);
    if (action === "merge" && method && !provider.info.capabilities.merge.includes(method)) throw new HostCommandError(`Choose ${provider.info.capabilities.merge.join(", ")}.`);
    await act(ref, { action, seen, ...(method ? { method } : {}) });
    forget(ref);
    services.log(action === "merge" ? "request.stack-merged" : "request.stack-rebased", `${noun(ref, provider)} · stack of ${seen.layers.length}`);
    return detail(ref, true);
  }, { long: true });

  const stackOf = async (ref: PullRequestRef): Promise<PullRequestStackMembership | undefined> => {
    const provider = sources.get(ref.service);
    if (!provider.stackMemberships || !provider.info.capabilities.stacks) return undefined;
    return (await provider.stackMemberships({ host: ref.host, repo: ref.repo }, [ref.number])).get(ref.number);
  };

  return { detail, stackOf };
}

/** The stack as the window showed it, checked field by field: it decides what a stack step may touch. */
function decodeStack(value: unknown): PullRequestStack | undefined {
  const raw = record(value);
  const number = typeof raw.number === "number" && Number.isInteger(raw.number) ? raw.number : undefined;
  if (number === undefined || !Array.isArray(raw.layers)) return undefined;
  const layers = raw.layers.map(record).flatMap((layer): PullRequestStackLayer[] => {
    const layerNumber = typeof layer.number === "number" && Number.isInteger(layer.number) ? layer.number : undefined;
    const state = layer.state === "open" || layer.state === "closed" || layer.state === "merged" ? layer.state : undefined;
    const headRef = text(layer.headRef);
    const url = text(layer.url);
    if (layerNumber === undefined || !state || !headRef || !url) return [];
    return [{ number: layerNumber, state, headRef, url, ...(text(layer.headSha) ? { headSha: text(layer.headSha) } : {}), ...(typeof layer.draft === "boolean" ? { draft: layer.draft } : {}) }];
  });
  return layers.length > 0 ? { number, base: text(raw.base) ?? "", layers } : undefined;
}
