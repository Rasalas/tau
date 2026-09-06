import type { HostExtension, HostExtensionContext } from "tau/host-extension";
import { REVIEW_HOST_EXTENSION_ID, type CommitMessageStyle } from "./protocol.js";

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
 * Review Kit's host entry: one command that turns a diff into a commit message
 * with the model the desktop side chose.
 */
export function createReviewHostExtension(): HostExtension {
  return {
    id: REVIEW_HOST_EXTENSION_ID,
    name: "Review Kit",
    permissions: ["sessions"],
    activate(context: HostExtensionContext) {
      const { services } = context;
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
        if (!provider || !modelId) throw new Error("Commit message generation needs a model. Pick one in Review Kit settings.");
        if (files.length === 0) throw new Error("There are no changes to describe.");
        if (services.runtimeOwner() === "pi") throw new Error("Write the commit message yourself while Pi is attached to the runtime.");
        const thread = services.thread();
        if (!thread) throw new Error("Pi runtime is not ready");
        if (thread.backendKind !== "pi") throw new Error("Commit message generation needs a Pi thread's model runtime.");

        services.log("commit-message.started", `${provider}/${modelId} · ${style}`);
        const answer = await thread.complete(provider, modelId, {
          system: SYSTEM_PROMPTS[style],
          prompt: buildCommitPrompt({ branch: text(fields.branch), files, diffs }),
          maxTokens: 220,
        });
        const message = cleanCommitMessage(answer);
        if (!message) throw new Error("The model returned an empty commit message.");
        services.log("commit-message.suggested", message.split(/\r?\n/u)[0]);
        return { message };
      });
    },
  };
}

export default createReviewHostExtension;
