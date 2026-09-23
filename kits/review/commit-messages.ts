import type { DesktopExtensionContext, ExtensionOption, PreferencesStore } from "tau";
import { REVIEW_HOST_EXTENSION_ID, type CommitMessageStyle, type WorkspaceStoreApi } from "./protocol.js";
import { INSTRUCTIONS_OPTION, TEMPLATE_OPTION } from "./writing.js";

const MODEL_OPTION = "commit-model";
const STYLE_OPTION = "commit-style";
const AUTO_OPTION = "propose-message";

export function commitMessageModel(threadModel: { provider: string; id: string } | undefined, preferences: PreferencesStore): { provider: string; id: string } | undefined {
  const stored = preferences.value(REVIEW_HOST_EXTENSION_ID, MODEL_OPTION) ?? "";
  const at = stored.indexOf("/");
  return at > 0 && at < stored.length - 1 ? { provider: stored.slice(0, at), id: stored.slice(at + 1) } : threadModel;
}

export function commitMessageStyle(preferences: PreferencesStore): CommitMessageStyle {
  const stored = preferences.value(REVIEW_HOST_EXTENSION_ID, STYLE_OPTION);
  return stored === "gitmoji" || stored === "plain" ? stored : "conventional";
}

/** What the user wants every commit message and request description to follow; empty when nothing. */
export function writingInstructions(preferences: PreferencesStore): string {
  return preferences.value(REVIEW_HOST_EXTENSION_ID, INSTRUCTIONS_OPTION)?.trim() ?? "";
}

/** Whether a request's description fills in the repository's template; on by default, as in T3 Code. */
export function followRequestTemplate(preferences: PreferencesStore): boolean {
  return preferences.optionValue(REVIEW_HOST_EXTENSION_ID, TEMPLATE_OPTION, true);
}

export function automaticCommitMessages(preferences: PreferencesStore): boolean {
  return preferences.optionValue(REVIEW_HOST_EXTENSION_ID, AUTO_OPTION, true);
}

export const COMMIT_MESSAGE_OPTIONS: ExtensionOption[] = [
  { id: AUTO_OPTION, kind: "toggle", label: "Generate a commit message when review opens", defaultValue: true },
  { id: MODEL_OPTION, kind: "model", label: "Model that writes commit messages" },
  {
    id: STYLE_OPTION,
    kind: "select",
    label: "Commit message format",
    defaultValue: "conventional",
    values: [
      { value: "conventional", label: "Conventional Commits" },
      { value: "gitmoji", label: "Gitmoji" },
      { value: "plain", label: "Plain Git subject" },
    ],
  },
];

export function registerCommitMessages(plugin: DesktopExtensionContext, workspace: WorkspaceStoreApi): () => void {
  return workspace.registerCommitMessageSuggester(async ({ changes, diffs, actions }) => {
    const model = commitMessageModel(actions.activeThread()?.model, plugin.preferences);
    if (!model) throw new Error("No model is selected for commit message generation.");
    const result = await plugin.host.invoke("suggest-commit-message", {
      provider: model.provider,
      modelId: model.id,
      style: commitMessageStyle(plugin.preferences),
      ...(writingInstructions(plugin.preferences) ? { instructions: writingInstructions(plugin.preferences) } : {}),
      branch: changes.branch,
      files: changes.files.map(({ path, added, removed }) => ({ path, added, removed })),
      diffs: diffs.map((diff) => ({
        path: diff.path,
        patch: diff.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines.map((line) => `${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}${line.text}`)]).join("\n"),
      })),
    }) as { message: string };
    return result.message;
  });
}
