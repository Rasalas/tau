import { HostCommandError, type HostExtensionContext, type UiReviewRequest } from "tau/host-extension";
import {
  THREAD_RAIL_EXTENSION_ID,
  WORKSPACE_HOST_EXTENSION_ID,
  type MergeMethod,
  type RequestService,
  type ReviewRequestContext,
  type ReviewRequestDraft,
  type ReviewRequestStatus,
} from "./protocol.js";
import { withInstructions } from "./writing.js";
import {
  authArgs,
  createArgs,
  createdUrl,
  defaultCliRunner,
  draftArgs,
  editArgs,
  explainCliFailure,
  mergeArgs,
  serviceFor,
  SERVICES,
  type CliRunner,
} from "./request-cli.js";

const AUTH_CACHE_MS = 60_000;
const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const draftSystemPrompt = (noun: string) => [
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
}

/**
 * Review Kit's request lifecycle: status, a generated draft, create, merge and
 * edit. Git goes through Workspace Kit's host entry (the commands that name
 * this kit as a caller); the hosting side goes through `gh` or `glab`, found
 * with `findCommand`. Every refusal names what is missing.
 */
export function registerRequestCommands(context: HostExtensionContext, options: RequestCommandOptions = {}): void {
  const { services } = context;
  const run = options.run ?? defaultCliRunner;
  const now = options.now ?? Date.now;
  // Only a login is remembered, so signing in shows on the next look.
  const signedIn = new Map<string, number>();

  const workspace = async <T>(command: string, input?: unknown): Promise<T> => {
    try {
      return await context.invokeHostExtension(WORKSPACE_HOST_EXTENSION_ID, command, input) as T;
    } catch (error) {
      throw new HostCommandError(message(error));
    }
  };

  const cli = async (service: RequestService, args: string[], cwd: string): Promise<string> => {
    const command = services.findCommand(SERVICES[service].tool);
    if (!command) throw new HostCommandError(missingTool(service));
    services.noteSubprocess();
    return run(command, args, cwd);
  };

  const authenticated = async (service: RequestService, cwd: string): Promise<boolean> => {
    const at = signedIn.get(service);
    if (at !== undefined && now() - at < AUTH_CACHE_MS) return true;
    const ok = await cli(service, authArgs(), cwd).then(() => true, () => false);
    if (ok) signedIn.set(service, now());
    return ok;
  };

  const missingTool = (service: RequestService) => {
    const facts = SERVICES[service];
    return `${facts.label} is not installed or not on your PATH. Install it from ${facts.install}, then run \`${facts.login}\`.`;
  };

  /** The first thing missing before a request can be opened, or undefined. */
  const problem = async (git: ReviewRequestContext, service: RequestService): Promise<string | undefined> => {
    const facts = SERVICES[service];
    if (!git.branch) return `Check out a branch to open a ${facts.noun}; HEAD is detached.`;
    if (!git.remote) return `This repository has no remote. Add one with \`git remote add origin <url>\` to open a ${facts.noun}.`;
    if (!services.findCommand(facts.tool)) return missingTool(service);
    if (!await authenticated(service, git.root)) return `${facts.label} is not signed in. Run \`${facts.login}\` in a terminal, then try again.`;
    return undefined;
  };

  const inspect = async (fresh: boolean): Promise<{ current: ReviewRequestStatus; git: ReviewRequestContext }> => {
    const git = await workspace<ReviewRequestContext>("review-request-context");
    const service = serviceFor(git.remote?.url, (name) => services.findCommand(name));
    const missing = await problem(git, service);
    const request = git.branch && git.remote && services.findCommand(SERVICES[service].tool)
      ? await workspace<UiReviewRequest | undefined>("review-request", { fresh })
      : undefined;
    const current: ReviewRequestStatus = {
      ...(git.branch ? { branch: git.branch } : {}),
      base: git.base,
      ...(git.remote ? { remote: git.remote.url } : {}),
      ...(git.upstream ? { upstream: git.upstream, ahead: git.ahead ?? 0 } : {}),
      service,
      ...(request ? { request } : {}),
      ...(missing ? { problem: missing } : {}),
    };
    return { current, git };
  };
  const status = async (fresh: boolean) => (await inspect(fresh)).current;

  /** Status for a step that needs everything in place; refuses with what is missing. */
  const ready = async (): Promise<{ current: ReviewRequestStatus; git: ReviewRequestContext }> => {
    const inspected = await inspect(true);
    if (inspected.current.problem) throw new HostCommandError(inspected.current.problem);
    return inspected;
  };

  const openRequest = (current: ReviewRequestStatus): UiReviewRequest => {
    const facts = SERVICES[current.service];
    const request = current.request;
    if (!request) throw new HostCommandError(`This branch has no ${facts.noun} yet.`);
    if (request.state && request.state !== "open") throw new HostCommandError(`${facts.short} #${request.number} is ${request.state}.`);
    return request;
  };

  context.registerCommand("pr-status", async (input) => {
    const named = text(record(input).workspace);
    // A rail row asks about any thread's checkout and only wants the request.
    if (named) return { request: await workspace<UiReviewRequest | undefined>("review-request", { workspace: named }) };
    return status(record(input).fresh === true);
  }, { callers: [THREAD_RAIL_EXTENSION_ID] }); // a merged or closed request settles a Thread Rail thread

  context.registerCommand("pr-draft", async (input): Promise<ReviewRequestDraft> => {
    const fields = record(input);
    const read = await workspace<ReviewRequestContext>("review-request-context", { detail: true, ...(text(fields.base) ? { base: text(fields.base) } : {}) });
    // The repository's template shapes the description unless the user turned that off.
    const git = fields.template === false ? { ...read, template: undefined } : read;
    const service = serviceFor(git.remote?.url, (name) => services.findCommand(name));
    const provider = text(fields.provider);
    const modelId = text(fields.modelId);
    // Pi attached to the runtime owns the model; the commits alone make the draft then.
    if (services.runtimeOwner() === "pi") return { ...fallbackDraft(git), base: git.base, generated: false };
    services.log("request-draft.started", provider && modelId ? `${provider}/${modelId}` : "default model");
    let answer: string;
    try {
      answer = await services.complete({ system: withInstructions(draftSystemPrompt(SERVICES[service].noun), fields.instructions), prompt: buildDraftPrompt(git), maxTokens: 900 }, provider && modelId ? { provider, id: modelId } : undefined);
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
    const { current, git } = await ready();
    const facts = SERVICES[current.service];
    if (current.request?.state === "open") throw new HostCommandError(`${facts.short} #${current.request.number} is already open for this branch.`);
    const base = text(fields.base)?.trim() || git.base;
    if (base === git.branch) throw new HostCommandError(`The ${facts.noun} would merge ${base} into itself; choose another base branch.`);
    await workspace("push");
    let output: string;
    try {
      output = await cli(current.service, createArgs(current.service, { title, body: text(fields.body) ?? "", base, head: git.branch!, draft: fields.draft === true }), git.root);
    } catch (error) {
      throw new HostCommandError(explainCliFailure(current.service, `Creating the ${facts.noun}`, error));
    }
    services.log("request.created", createdUrl(output) ?? title);
    return { status: await status(true), url: createdUrl(output) };
  }, { long: true });

  context.registerCommand("pr-merge", async (input) => {
    const method = MERGE_METHODS.find((candidate) => candidate === record(input).method);
    if (!method) throw new HostCommandError("Choose squash, merge or rebase.");
    const { current, git } = await ready();
    const request = openRequest(current);
    try {
      await cli(current.service, mergeArgs(current.service, request.number, method), git.root);
    } catch (error) {
      throw new HostCommandError(explainCliFailure(current.service, `Merging ${SERVICES[current.service].short} #${request.number}`, error));
    }
    services.log("request.merged", `#${request.number} · ${method}`);
    return status(true);
  }, { long: true });

  context.registerCommand("pr-edit", async (input) => {
    const fields = record(input);
    const title = text(fields.title)?.trim();
    const body = text(fields.body);
    if (title !== undefined && !title) throw new HostCommandError("A title is required.");
    const { current, git } = await ready();
    const request = openRequest(current);
    const action = `Editing ${SERVICES[current.service].short} #${request.number}`;
    try {
      if (title !== undefined || body !== undefined) {
        await cli(current.service, editArgs(current.service, request.number, { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) }), git.root);
      }
      if (typeof fields.draft === "boolean" && fields.draft !== request.draft) {
        await cli(current.service, draftArgs(current.service, request.number, fields.draft), git.root);
      }
    } catch (error) {
      throw new HostCommandError(explainCliFailure(current.service, action, error));
    }
    services.log("request.edited", `#${request.number}`);
    return status(true);
  }, { long: true });
}
