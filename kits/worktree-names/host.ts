import { smallCompletionModel, type HostExtension, type HostExtensionContext } from "tau/host-extension";
import { WORKTREE_NAMES_HOST_EXTENSION_ID } from "./protocol.js";

const SYSTEM_PROMPT = "You name Git branches for coding tasks. Answer with one branch name only: lowercase words joined by hyphens, optionally led by a type such as feat/, fix/, chore/, refactor/ or docs/, then two to five words, at most 40 characters. No quotes, no explanation, no Markdown.";

const MAX_LENGTH = 60;

/** Turns whatever the model answered into a branch name Git accepts, distinct from `taken`. */
export function branchNameFromSuggestion(text: string, taken: readonly string[] = []): string {
  const line = text.split(/\r?\n/u).map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
  let name = line
    .replace(/^[`"'*\s]+|[`"'*.\s]+$/gu, "")
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9/._-]+/gu, "")
    .replace(/\.{2,}/gu, ".")
    .replace(/-*\/+-*/gu, "/")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-./]+|[-./]+$/gu, "")
    .replace(/\.lock$/u, "")
    .slice(0, MAX_LENGTH)
    .replace(/[-./]+$/u, "");
  if (!name) return "";
  const used = new Set(taken.map((entry) => entry.toLowerCase()));
  if (!used.has(name)) return name;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${name}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  return "";
}

/** The prompt the naming model reads: the task, the user's own start on a name, and names to avoid. */
export function buildNamingPrompt(description: string, hint: string, taken: readonly string[]): string {
  const parts = [`Task:\n${description.trim().slice(0, 4000) || "(not described)"}`];
  if (hint.trim()) parts.push(`The user started typing this name: ${hint.trim()}`);
  if (taken.length) parts.push(`Existing branches, do not reuse: ${taken.slice(0, 60).join(", ")}`);
  parts.push("Return only the branch name. Use English words.");
  return parts.join("\n\n");
}

const record = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";

/**
 * Worktree Names' host entry. It borrows a model runtime from an open thread;
 * creating the worktree itself stays with Workspace Kit.
 */
export function createWorktreeNamesHostExtension(): HostExtension {
  return {
    id: WORKTREE_NAMES_HOST_EXTENSION_ID,
    name: "Worktree Names",
    activate(context: HostExtensionContext) {
      const { services } = context;
      context.registerCommand("suggest", async (input) => {
        const fields = record(input);
        const provider = text(fields.provider);
        const modelId = text(fields.modelId);
        const preferred = record(fields.prefer);
        const prefer = text(preferred.provider) && text(preferred.id) ? { provider: text(preferred.provider), id: text(preferred.id) } : undefined;
        const description = text(fields.description);
        const hint = text(fields.hint);
        const taken = Array.isArray(fields.taken) ? fields.taken.filter((entry): entry is string => typeof entry === "string") : [];
        if (!description.trim() && !hint.trim()) throw new Error("Describe the task in the composer first, or type the start of a name.");
        if (services.runtimeOwner() === "pi") throw new Error("Name the worktree yourself while Pi is attached to the runtime.");
        const thread = services.thread();
        if (!thread) throw new Error("Pi runtime is not ready");
        const model = provider && modelId ? { provider, id: modelId } : await smallCompletionModel(services, prefer);
        services.log("worktree-name.started", model ? `${model.provider}/${model.id}` : "default model");
        const answer = await services.complete({
          system: SYSTEM_PROMPT,
          prompt: buildNamingPrompt(description, hint, taken),
          maxTokens: 32,
        }, model);
        const branch = branchNameFromSuggestion(answer, taken);
        if (!branch) throw new Error("The model did not answer with a usable branch name.");
        services.log("worktree-name.suggested", branch);
        return { branch };
      });
    },
  };
}

export default createWorktreeNamesHostExtension;
