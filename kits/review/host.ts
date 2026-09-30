import { HostCommandError, type HostExtension, type HostExtensionContext } from "tau/host-extension";
import { REVIEW_HOST_EXTENSION_ID, WORKSPACE_HOST_EXTENSION_ID, type CommitMessageStyle } from "./protocol.js";
import { registerPullRequestCommands } from "./pull-request-host.js";
import { createSourceControl, type SourceControlOptions } from "./provider-registry.js";
import { registerProviderSettings } from "./provider-settings-host.js";
import { registerPullRequestListCommands } from "./pull-request-list-host.js";
import { withInstructions } from "./writing.js";
import { registerPublishCommands } from "./publish-host.js";
import { registerRequestCommands, type RequestCommandOptions } from "./requests-host.js";
import { registerLocalRequestCommands } from "./local-request-host.js";
import { registerLocalReviewCommands } from "./local-reviews-host.js";
import { registerThreadLinks, type ThreadLinks } from "./thread-links-host.js";

const SYSTEM_PROMPTS: Record<CommitMessageStyle, string> = {
  conventional: "Write one excellent Conventional Commit message for the supplied Git diff. Use an accurate type and an optional short scope. The imperative subject must explain the intent, not list files. Keep the subject under 72 characters. Add a short body only when it explains important behavior or migration details. Return only the commit message, without quotes or Markdown fences.",
  gitmoji: "Write one concise Git commit message for the supplied diff. Start with one fitting gitmoji, then an imperative subject that explains the intent rather than listing files. Keep the first line under 72 characters. Return only the commit message, without quotes or Markdown fences.",
  plain: "Write one concise Git commit message for the supplied diff. Use an imperative subject that explains the intent rather than listing files. Keep the first line under 72 characters. Add a short body only if needed. Return only the commit message, without quotes or Markdown fences.",
};

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

export function cleanCommitMessage(answer: string): string {
  return answer.trim()
    .replace(/^```(?:text)?\s*/u, "")
    .replace(/\s*```$/u, "")
    .replace(/^["']|["']$/gu, "")
    .trim();
}

export function buildCommitPrompt(input: {
  branch?: string;
  files: Array<{ path: string; added: number; removed: number }>;
  diffs: Array<{ path: string; patch: string }>;
}): string {
  const files = input.files.slice(0, 200).map((file) => `${file.path} (+${file.added} -${file.removed})`).join("\n");
  const patches = input.diffs.slice(0, 80).map((diff) => `--- ${diff.path}\n${diff.patch.slice(0, 12_000)}`).join("\n\n").slice(0, 80_000);
  return [`Branch: ${input.branch || "(detached)"}`, `Changed files:\n${files}`, `Diff excerpts:\n${patches || "(diff content unavailable)"}`].join("\n\n");
}

/**
 * Review Kit's host entry: a commit message from a diff with the model the
 * desktop side chose, the pull or merge request lifecycle after it, the
 * reads and writes of the pull-request view and the Pull Requests page, and
 * the requests each thread links, with the agent's tools for them.
 */
export function createReviewHostExtension(options: RequestCommandOptions & SourceControlOptions = {}): HostExtension {
  return {
    id: REVIEW_HOST_EXTENSION_ID,
    name: "Review Kit",
    permissions: ["sessions", "process", "network", "runtime:extend"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      // Review's desktop half reaches the Workspace read API through this
      // host-owned context. Workspace declares the two commands as callers of
      // tau.review, so this proxy cannot be widened by renderer input.
      context.registerCommand("changes", (input) => context.invokeHostExtension(WORKSPACE_HOST_EXTENSION_ID, "changes", input), { access: "read" });
      context.registerCommand("file-diff", (input) => context.invokeHostExtension(WORKSPACE_HOST_EXTENSION_ID, "file-diff", input), { access: "read" });
      const sources = createSourceControl(context, options);
      const workspace = (command: string, input?: unknown) => context.invokeHostExtension(WORKSPACE_HOST_EXTENSION_ID, command, input);
      let links: ThreadLinks | undefined;
      // A revert opened from a request's view belongs to the thread it was opened from.
      const reads = registerPullRequestCommands(context, sources, { ...options, created: (url, threadId) => { if (threadId) void links?.link(threadId, url, "created"); } });
      registerPullRequestListCommands(context, sources, workspace);
      links = registerThreadLinks(context, reads, workspace, sources);
      registerRequestCommands(context, sources, {
        ...options,
        // A request opened from the Changes panel belongs to the thread on screen.
        created: (url) => { const thread = services.thread(); if (thread) void links?.link(thread.sessionId, url, "created"); },
      });
      registerLocalRequestCommands(context, sources);
      registerLocalReviewCommands(context, workspace, (threadIds, branch) => links?.merged(threadIds, branch) ?? Promise.resolve(false));
      registerPublishCommands(context, options);
      registerProviderSettings(context, sources);
      context.registerCommand("suggest-commit-message", async (input) => {
        const fields = record(input);
        const provider = text(fields.provider);
        const modelId = text(fields.modelId);
        const style = (["conventional", "gitmoji", "plain"] as const).includes(fields.style as CommitMessageStyle)
          ? fields.style as CommitMessageStyle
          : "conventional";
        const files = Array.isArray(fields.files) ? fields.files.map(record).map((file) => ({
          path: text(file.path),
          added: typeof file.added === "number" ? file.added : 0,
          removed: typeof file.removed === "number" ? file.removed : 0,
        })).filter((file) => file.path) : [];
        const diffs = Array.isArray(fields.diffs) ? fields.diffs.map(record).map((diff) => ({ path: text(diff.path), patch: text(diff.patch) })).filter((diff) => diff.path) : [];
        if (files.length === 0) throw new HostCommandError("There are no changes to describe.");
        if (services.runtimeOwner() === "pi") throw new HostCommandError("Write the commit message yourself while Pi is attached to the runtime.");
        const thread = services.thread();
        if (!thread) throw new HostCommandError("Pi runtime is not ready");
        services.log("commit-message.started", `${provider && modelId ? `${provider}/${modelId}` : "default model"} · ${style}`);
        let answer: string;
        try {
          answer = await services.complete({
            system: withInstructions(SYSTEM_PROMPTS[style], fields.instructions),
            prompt: buildCommitPrompt({ branch: text(fields.branch), files, diffs }),
            maxTokens: 220,
          }, provider && modelId ? { provider, id: modelId } : undefined);
        } catch (error) {
          throw new HostCommandError(error instanceof Error ? error.message : String(error));
        }
        const message = cleanCommitMessage(answer);
        if (!message) throw new HostCommandError("The model returned an empty commit message.");
        services.log("commit-message.suggested", message.split(/\r?\n/u)[0]);
        return { message };
      });
      return () => links?.dispose();
    },
  };
}

export default createReviewHostExtension;
