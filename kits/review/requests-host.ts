import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import {
  THREAD_RAIL_EXTENSION_ID,
  WORKSPACE_HOST_EXTENSION_ID,
  type MergeMethod,
  type MergeOutcome,
  type ReviewRequest,
  type ReviewRequestContext,
  type ReviewRequestDraft,
  type ReviewRequestStatus,
} from "./protocol.js";
import type { RepositoryTarget, SourceControlProvider } from "./provider.js";
import type { SourceControl } from "./provider-registry.js";
import { withInstructions } from "./writing.js";
import { attachmentReader, embedMedia } from "./evidence-upload.js";
import { findEvidenceTokens } from "./local-request.js";
import { SERVICES, type CliRunner } from "./request-cli.js";

const AUTH_CACHE_MS = 60_000;
/** A branch's request is asked again after this long; `fresh` asks at once. */
const BRANCH_REQUEST_MS = 30_000;
const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];
const METHOD_WORDS: Record<MergeMethod, string> = { squash: "squash", merge: "merge commit", rebase: "rebase" };

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const draftSystemPrompt = (noun: string) => [
  `Write the title and description of a ${noun} for the supplied branch.`,
  "First line: the title, imperative, under 72 characters, no prefix like 'Title:'.",
  "Then one blank line, then the description in Markdown.",
  "When a template is supplied, fill in its sections and keep its headings instead of inventing a structure.",
  "Explain the intent and notable behavior changes; do not list every file.",
  "Return only the title and the description, without quotes or code fences.",
].join(" ");

export function buildDraftPrompt(context: ReviewRequestContext): string {
  const commits = (context.commits ?? []).map((commit) => `- ${commit.subject}${commit.body ? `\n  ${commit.body.replace(/\n/gu, "\n  ").slice(0, 2_000)}` : ""}`).join("\n");
  return [
    `Branch: ${context.branch ?? "(detached)"} into ${context.base}`,
    `Commits:\n${commits || "(none)"}`,
    `Diff stat:\n${context.diffStat || "(unavailable)"}`,
    context.template ? `Template:\n${context.template}` : "",
  ].filter(Boolean).join("\n\n").slice(0, 60_000);
}

/** First line is the title, the rest the body; fences and a "Title:" label are dropped. */
export function parseDraft(answer: string): { title: string; body: string } {
  const cleaned = answer.trim().replace(/^```(?:markdown|md|text)?\s*/u, "").replace(/\s*```$/u, "").trim();
  const [first = "", ...rest] = cleaned.split(/\r?\n/u);
  const title = first.replace(/^#+\s*/u, "").replace(/^title:\s*/iu, "").replace(/^["']|["']$/gu, "").trim();
  return { title, body: rest.join("\n").trim() };
}

/** Without a model the commits still say something: the only subject, or the branch in words. */
export function fallbackDraft(context: ReviewRequestContext): { title: string; body: string } {
  const commits = context.commits ?? [];
  const branchWords = (context.branch ?? "").split("/").at(-1)?.replace(/[-_]+/gu, " ").trim() ?? "";
  const title = commits.length === 1 ? commits[0]!.subject : branchWords ? branchWords.charAt(0).toUpperCase() + branchWords.slice(1) : "Update";
  const list = commits.map((commit) => `- ${commit.subject}`).join("\n");
  return { title, body: context.template ?? list };
}

export interface RequestCommandOptions {
  run?: CliRunner;
  now?(): number;
  /** A request was just opened; its URL. */
  created?(url: string): void;
}

/** A checkout the lifecycle acts on: its Git facts, its provider and where the provider finds its repository. */
interface Inspected {
  current: ReviewRequestStatus;
  git: ReviewRequestContext;
  provider: SourceControlProvider;
  target: RepositoryTarget & { cwd: string };
}

/**
 * Review Kit's request lifecycle: status, a generated draft, create, merge and
 * edit. Git goes through Workspace Kit's host entry (the commands that name
 * this kit as a caller); the hosting side goes through the provider the
 * remote belongs to. Every refusal names what is missing.
 */
export function registerRequestCommands(context: HostExtensionContext, sources: SourceControl, options: RequestCommandOptions = {}): void {
  const { services } = context;
  const now = options.now ?? Date.now;
  // Only a login is remembered, so signing in shows on the next look.
  const signedIn = new Map<string, number>();
  const branchRequests = new Map<string, { at: number; revision: number; value: Promise<ReviewRequest | undefined> }>();

  const workspace = async <T>(command: string, input?: unknown): Promise<T> => await sources.tools.workspace(command, input) as T;

  /** True when signed in; a provider may answer with a sentence of its own for what is missing instead. */
  const authenticated = async (provider: SourceControlProvider, target: RepositoryTarget & { cwd: string }): Promise<boolean | string> => {
    const key = `${provider.kind}\0${target.host}`;
    const at = signedIn.get(key);
    if (at !== undefined && now() - at < AUTH_CACHE_MS) return true;
    const ok = await provider.signedIn(target).catch((error: unknown) => error instanceof HostCommandError ? error.message : false);
    if (ok === true) signedIn.set(key, now());
    return ok;
  };

  /** Where the provider finds the repository; a CLI that reads the checkout's remote needs no more than the checkout. */
  const targetOf = (provider: SourceControlProvider, git: Pick<ReviewRequestContext, "root" | "remote">): (RepositoryTarget & { cwd: string }) | undefined => {
    const found = git.remote ? provider.repository(git.remote.url) : undefined;
    if (found) return { ...found, cwd: git.root };
    return provider.kind === "github" || provider.kind === "gitlab" ? { host: "", repo: "", cwd: git.root } : undefined;
  };

  /**
   * The request of a checkout's branch through the provider its remote
   * belongs to, reused for half a minute per checkout and branch. Undefined
   * for no request, and for anything that keeps the provider from answering.
   */
  const branchRequest = async (git: Pick<ReviewRequestContext, "root" | "branch" | "remote">, fresh: boolean): Promise<ReviewRequest | undefined> => {
    if (!git.branch || !git.remote) return undefined;
    const provider = sources.get(await sources.detect(git.remote.url));
    const target = targetOf(provider, git);
    if (!target || provider.missing()) return undefined;
    const key = `${provider.kind}\0${git.root}\0${git.branch}`;
    const held = branchRequests.get(key);
    if (held && !fresh && held.revision === sources.revision() && now() - held.at < BRANCH_REQUEST_MS) return held.value;
    const value = provider.current({ ...target, branch: git.branch, fresh }).catch(() => undefined);
    branchRequests.set(key, { at: now(), revision: sources.revision(), value });
    return value;
  };

  /** The first thing missing before a request can be opened, or undefined. */
  const problem = async (git: ReviewRequestContext, provider: SourceControlProvider, target: (RepositoryTarget & { cwd: string }) | undefined): Promise<string | undefined> => {
    const { info } = provider;
    if (!git.branch) return `Check out a branch to open a ${info.noun}; HEAD is detached.`;
    if (!git.remote) return `This repository has no remote. Publish it, or add one with \`git remote add origin <url>\`, to open a ${info.noun}.`;
    const missing = provider.missing();
    if (missing) return missing;
    if (!target) return `${git.remote.name} (${git.remote.url}) names no ${info.name} repository Tau can read.`;
    const signed = await authenticated(provider, target);
    if (typeof signed === "string") return signed;
    if (!signed) {
      const facts = SERVICES[provider.kind];
      return `${facts.label} is not signed in. Run \`${facts.login}\` in a terminal, then try again.`;
    }
    return undefined;
  };

  const inspect = async (fresh: boolean): Promise<Inspected> => {
    const git = await workspace<ReviewRequestContext>("review-request-context");
    const provider = sources.get(await sources.detect(git.remote?.url));
    const target = targetOf(provider, git);
    const missing = await problem(git, provider, target);
    const request = await branchRequest(git, fresh);
    const current: ReviewRequestStatus = {
      ...(git.branch ? { branch: git.branch } : {}),
      base: git.base,
      ...(git.remote ? { remote: git.remote.url } : {}),
      ...(git.upstream ? { upstream: git.upstream, ahead: git.ahead ?? 0 } : {}),
      service: provider.kind,
      ...(request ? { request } : {}),
      ...(missing ? { problem: missing } : {}),
    };
    return { current, git, provider, target: target ?? { host: "", repo: "", cwd: git.root } };
  };
  const status = async (fresh: boolean) => (await inspect(fresh)).current;

  /** Status for a step that needs everything in place; refuses with what is missing. */
  const ready = async (): Promise<Inspected> => {
    const inspected = await inspect(true);
    if (inspected.current.problem) throw new HostCommandError(inspected.current.problem);
    return inspected;
  };

  const refuseMethod = (provider: SourceControlProvider, method: MergeMethod) => {
    const methods = provider.info.capabilities.merge;
    if (methods.includes(method)) return;
    throw new HostCommandError(methods.length === 0
      ? `${provider.info.name} does not let Tau merge; merge it on the website.`
      : `${provider.info.name} merges by ${methods.map((entry) => METHOD_WORDS[entry]).join(" or ")} only.`);
  };

  const openRequest = ({ current, provider }: Inspected): ReviewRequest => {
    const { info } = provider;
    const request = current.request;
    if (!request) throw new HostCommandError(`This branch has no ${info.noun} yet.`);
    if (request.state && request.state !== "open") throw new HostCommandError(`${info.short} #${request.number} is ${request.state}.`);
    return request;
  };

  /** A rail row's request: any thread's checkout, named by its workspace. */
  const rowRequest = async (named: string): Promise<ReviewRequest | undefined> => {
    const git = await workspace<ReviewRequestContext>("review-request-context", { workspace: named }).catch(() => undefined);
    return git ? branchRequest(git, false) : undefined;
  };

  context.registerCommand("pr-status", async (input) => {
    const named = text(record(input).workspace);
    // A rail row asks about any thread's checkout and only wants the request.
    if (named) return { request: await rowRequest(named) };
    return status(record(input).fresh === true);
  }, { callers: [THREAD_RAIL_EXTENSION_ID] }); // a merged or closed request settles a Thread Rail thread

  // Workspace Kit bases a branch diff on the request and counts a merged one for its cleanup; it names the Git facts.
  context.registerCommand("branch-request", async (input) => {
    const fields = record(input);
    const root = text(fields.root);
    const branch = text(fields.branch);
    const remote = text(fields.remote);
    if (!root || !branch || !remote) return undefined;
    return branchRequest({ root, branch, remote: { name: "origin", url: remote } }, fields.fresh === true);
  }, { callers: [WORKSPACE_HOST_EXTENSION_ID] });

  context.registerCommand("pr-draft", async (input): Promise<ReviewRequestDraft> => {
    const fields = record(input);
    const read = await workspace<ReviewRequestContext>("review-request-context", { detail: true, ...(text(fields.base) ? { base: text(fields.base) } : {}) });
    // The repository's template shapes the description unless the user turned that off.
    const git = fields.template === false ? { ...read, template: undefined } : read;
    const { info } = sources.get(await sources.detect(git.remote?.url));
    const provider = text(fields.provider);
    const modelId = text(fields.modelId);
    // Pi attached to the runtime owns the model; the commits alone make the draft then.
    if (services.runtimeOwner() === "pi") return { ...fallbackDraft(git), base: git.base, generated: false };
    services.log("request-draft.started", provider && modelId ? `${provider}/${modelId}` : "default model");
    let answer: string;
    try {
      answer = await services.complete({ system: withInstructions(draftSystemPrompt(info.noun), fields.instructions), prompt: buildDraftPrompt(git), maxTokens: 900 }, provider && modelId ? { provider, id: modelId } : undefined);
    } catch (error) {
      services.log("request-draft.failed", message(error));
      return { ...fallbackDraft(git), base: git.base, generated: false };
    }
    const draft = parseDraft(answer);
    if (!draft.title) return { ...fallbackDraft(git), base: git.base, generated: false };
    return { ...draft, base: git.base, generated: true };
  }, { long: true });

  context.registerCommand("pr-create", async (input) => {
    const fields = record(input);
    const title = text(fields.title)?.trim();
    if (!title) throw new HostCommandError("A title is required.");
    const inspected = await ready();
    const { current, git, provider, target } = inspected;
    const { info } = provider;
    if (!info.capabilities.create) throw new HostCommandError(`${info.name} does not let Tau open a ${info.noun}; open it on the website.`);
    if (current.request?.state === "open") throw new HostCommandError(`${info.short} #${current.request.number} is already open for this branch.`);
    const base = text(fields.base)?.trim() || git.base;
    if (base === git.branch) throw new HostCommandError(`The ${info.noun} would merge ${base} into itself; choose another base branch.`);
    const draft = fields.draft === true && info.capabilities.draft;
    // Pictures named in the body go up first; a failed upload creates nothing.
    const written = text(fields.body) ?? "";
    if (findEvidenceTokens(written).length > 0 && fields.uploadConfirmed !== true) throw new HostCommandError("Confirm what is uploaded first.");
    const embedded = await embedMedia({ provider, target, ...(git.branch ? { branch: git.branch } : {}), body: written, read: attachmentReader(context), tools: sources.tools });
    await workspace("push");
    const created = await provider.create(target, { title, body: embedded.body, base, head: git.branch!, draft });
    services.log("request.created", created ?? title);
    const next = await status(true);
    const url = created ?? next.request?.url;
    if (url) options.created?.(url);
    return { status: next, url: created, ...(embedded.uploaded || embedded.kept ? { uploaded: embedded.uploaded, kept: embedded.kept } : {}) };
  }, { long: true });

  context.registerCommand("pr-merge", async (input): Promise<ReviewRequestStatus & { merge?: MergeOutcome }> => {
    const fields = record(input);
    const method = MERGE_METHODS.find((candidate) => candidate === fields.method);
    if (!method) throw new HostCommandError("Choose squash, merge or rebase.");
    const inspected = await ready();
    const { provider, target } = inspected;
    const request = openRequest(inspected);
    refuseMethod(provider, method);
    const deleteBranch = fields.deleteBranch === true && provider.info.capabilities.deleteBranch;
    const outcome = await provider.merge(target, request, method, { deleteBranch });
    services.log("request.merged", `#${request.number} · ${method}${outcome?.branchDeleted ? " · branch deleted" : ""}`);
    const next = await status(true);
    return outcome ? { ...next, merge: outcome } : next;
  }, { long: true });

  context.registerCommand("pr-auto-merge", async (input) => {
    const fields = record(input);
    const enable = fields.enable !== false;
    const method = MERGE_METHODS.find((candidate) => candidate === fields.method);
    const inspected = await ready();
    const { provider, target } = inspected;
    const request = openRequest(inspected);
    const arm = provider.autoMerge;
    if (!arm || !provider.info.capabilities.autoMerge) throw new HostCommandError(`${provider.info.name} does not let Tau merge automatically; merge when it is ready.`);
    if (enable && method) refuseMethod(provider, method);
    await arm(target, request, enable, method, { deleteBranch: fields.deleteBranch === true && provider.info.capabilities.deleteBranch });
    services.log(enable ? "request.auto-merge" : "request.auto-merge-off", `#${request.number}${enable && method ? ` · ${method}` : ""}`);
    return status(true);
  }, { long: true });

  context.registerCommand("pr-edit", async (input) => {
    const fields = record(input);
    const title = text(fields.title)?.trim();
    const body = text(fields.body);
    if (title !== undefined && !title) throw new HostCommandError("A title is required.");
    const inspected = await ready();
    const { provider, target } = inspected;
    const request = openRequest(inspected);
    const { capabilities } = provider.info;
    if (title !== undefined || body !== undefined) {
      if (!capabilities.edit) throw new HostCommandError(`${provider.info.name} does not let Tau edit a ${provider.info.noun}.`);
      await provider.edit(target, request, { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) });
    }
    if (typeof fields.draft === "boolean" && fields.draft !== request.draft) {
      if (!capabilities.draft) throw new HostCommandError(`${provider.info.name} keeps no drafts Tau can switch.`);
      await provider.setDraft(target, { ...request, ...(title !== undefined ? { title } : {}) }, fields.draft);
    }
    services.log("request.edited", `#${request.number}`);
    return status(true);
  }, { long: true });
}
