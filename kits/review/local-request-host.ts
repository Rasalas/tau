import { HostCommandError, smallCompletionModel, type HostExtensionContext } from "tau/host-extension";
import { attachmentReader, embedMedia, planUpload } from "./evidence-upload.js";
import { findEvidenceTokens, type LocalBranch, type LocalEvidence, type UploadPlan } from "./local-request.js";
import type { ReviewRequestContext, ReviewRequestDraft } from "./protocol.js";
import type { SourceControl } from "./provider-registry.js";
import { buildDraftPrompt, draftSystemPrompt, fallbackDraft, parseDraft } from "./requests-host.js";
import { withInstructions } from "./writing.js";

/** Threads one view reads pictures of, at most; the rest are the oldest. */
const MAX_THREADS = 40;

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const modelRef = (value: unknown): { provider: string; id: string } | undefined => {
  const fields = record(value);
  const provider = text(fields.provider);
  const id = text(fields.id);
  return provider && id ? { provider, id } : undefined;
};

/**
 * The local pull request's host commands: the branch against its base, the
 * pictures of the checkout's threads through `services.turnAttachments`, a
 * description written on request with a small model, where pictures would
 * go, and pictures added to an open request as a comment.
 */
export function registerLocalRequestCommands(context: HostExtensionContext, sources: SourceControl): void {
  const { services } = context;
  const workspace = async <T>(command: string, input?: unknown): Promise<T> => await sources.tools.workspace(command, input) as T;
  const read = attachmentReader(context);

  context.registerCommand("local-pr", async (input): Promise<LocalBranch> => {
    const base = text(record(input).base);
    const git = await workspace<ReviewRequestContext>("review-request-context", { detail: true, ...(base ? { base } : {}) });
    return {
      root: git.root,
      ...(git.branch ? { branch: git.branch } : {}),
      base: git.base,
      ...(git.remote ? { remote: git.remote.url } : {}),
      commits: (git.commits ?? []).flatMap((commit) => commit.sha && commit.at !== undefined
        ? [{ sha: commit.sha, subject: commit.subject, body: commit.body, at: commit.at, ...(commit.author ? { author: commit.author } : {}) }]
        : []),
      ...(git.forkedAt ? { forkedAt: git.forkedAt } : {}),
      ...(git.diffStat ? { diffStat: git.diffStat } : {}),
    };
  }, { long: true });

  context.registerCommand("local-pr-evidence", async (input): Promise<{ available: boolean; evidence: LocalEvidence[] }> => {
    const attachments = services.turnAttachments;
    if (!attachments) return { available: false, evidence: [] };
    const fields = record(input);
    const named = (Array.isArray(fields.threads) ? fields.threads : []).filter((id): id is string => typeof id === "string" && id.length > 0);
    // Pi's own threads of the checkout, whether or not the window lists them.
    const root = text(fields.root);
    const stored = root ? (await services.sessions.list().catch(() => [])).filter((session) => session.cwd === root).map((session) => session.sessionId) : [];
    const threads = [...new Set([...named, ...stored])].slice(0, MAX_THREADS);
    const lists = await Promise.all(threads.map(async (threadId) => (await attachments.list(threadId).catch(() => [])).map((entry): LocalEvidence => ({
      threadId,
      source: entry.source,
      id: entry.id,
      turnId: entry.turnId ?? `at-${entry.id}`,
      turnStartedAt: entry.turnStartedAt ?? entry.at,
      ...(entry.turnEndedAt === undefined ? {} : { turnEndedAt: entry.turnEndedAt }),
      at: entry.at,
      mediaType: entry.mediaType,
      size: entry.size,
      width: entry.width ?? 0,
      height: entry.height ?? 0,
      caption: entry.caption ?? "",
    }))));
    return { available: true, evidence: lists.flat().filter((entry) => entry.mediaType.startsWith("image/")) };
  });

  context.registerCommand("local-pr-image", async (input) => {
    const fields = record(input);
    const threadId = text(fields.threadId);
    const source = text(fields.source);
    const id = text(fields.id);
    if (!threadId || !source || !id) throw new HostCommandError("Name the picture by thread, source and id.");
    const data = await read({ threadId, source, id, caption: "" });
    return data ? `data:${data.mediaType};base64,${data.data}` : null;
  });

  // Only on a click: the model is the user's own choice for Review's writing, else a small one near the thread's.
  context.registerCommand("local-pr-describe", async (input): Promise<ReviewRequestDraft & { model?: string }> => {
    const fields = record(input);
    const base = text(fields.base);
    const found = await workspace<ReviewRequestContext>("review-request-context", { detail: true, ...(base ? { base } : {}) });
    const git = fields.template === false ? { ...found, template: undefined } : found;
    const { info } = sources.get(await sources.detect(git.remote?.url));
    const captions = (Array.isArray(fields.evidence) ? fields.evidence : []).filter((caption): caption is string => typeof caption === "string" && caption.trim().length > 0).slice(0, 30);
    if (services.runtimeOwner() === "pi") return { ...fallbackDraft(git), base: git.base, generated: false };
    const model = modelRef(fields.model) ?? await smallCompletionModel(services, modelRef(fields.prefer));
    const label = model ? `${model.provider}/${model.id}` : "default model";
    services.log("local-request.describe", label);
    const prompt = [
      buildDraftPrompt(git),
      captions.length > 0 ? `Screenshots the description embeds after its text (refer to them where they show a change; do not add image links yourself):\n${captions.map((caption) => `- ${caption}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    let answer: string;
    try {
      answer = await services.complete({ system: withInstructions(draftSystemPrompt(info.noun), fields.instructions), prompt, maxTokens: 900 }, model);
    } catch (error) {
      services.log("local-request.describe-failed", message(error));
      throw new HostCommandError(`The description could not be written: ${message(error)}`);
    }
    const draft = parseDraft(answer);
    if (!draft.title) throw new HostCommandError("The model answered without a title; try again.");
    return { ...draft, base: git.base, generated: true, ...(model ? { model: label } : {}) };
  }, { long: true });

  /** Where the checkout's pictures, or a request's, would go. */
  const plan = async (url: string | undefined): Promise<UploadPlan> => {
    if (url) {
      const found = sources.forUrl(url);
      if (!found) throw new HostCommandError("Tau does not know the host of that request.");
      return planUpload(found.provider, { host: found.ref.host, repo: found.ref.repo }, sources.tools);
    }
    const git = await workspace<ReviewRequestContext>("review-request-context");
    const provider = sources.get(await sources.detect(git.remote?.url));
    const target = git.remote ? provider.repository(git.remote.url) : undefined;
    if (!target) return { kind: "none", reason: git.remote ? "Tau could not tell which repository the remote names." : "This repository has no remote yet." };
    return planUpload(provider, target, sources.tools, git.branch);
  };

  context.registerCommand("local-pr-upload-plan", (input) => plan(text(record(input).url)), { long: true });

  context.registerCommand("pr-attach-evidence", async (input) => {
    const fields = record(input);
    const url = text(fields.url);
    if (!url) throw new HostCommandError("Name the request the pictures go to.");
    if (fields.uploadConfirmed !== true) throw new HostCommandError("Confirm what is uploaded first.");
    const found = sources.forUrl(url);
    if (!found) throw new HostCommandError("Tau does not know the host of that request.");
    const body = typeof fields.body === "string" ? fields.body : "";
    if (findEvidenceTokens(body).length === 0) throw new HostCommandError("Choose at least one picture.");
    const target = { host: found.ref.host, repo: found.ref.repo };
    const branch = text(fields.branch);
    const embedded = await embedMedia({ provider: found.provider, target, ...(branch ? { branch } : {}), body, read, tools: sources.tools });
    if (embedded.uploaded === 0) throw new HostCommandError(embedded.plan?.kind === "none" ? embedded.plan.reason : "Nothing was uploaded.");
    await found.provider.comment(found.ref, embedded.body);
    sources.tools.forget(found.ref);
    services.log("local-request.attached", `${embedded.uploaded} to #${found.ref.number}`);
    return { uploaded: embedded.uploaded };
  }, { long: true });
}
