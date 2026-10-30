import type { DesktopExtensionContext, ExtensionOption, PreferencesStore } from "tau";
import { textChoice, textChoiceInput, type ModelRef, type TextChoice } from "../_shared/text-generation.js";
import { REVIEW_HOST_EXTENSION_ID, type CommitMessageStyle, type WorkspaceStoreApi } from "./protocol.js";
import { INSTRUCTIONS_OPTION, TEMPLATE_OPTION } from "./writing.js";

const STYLE_OPTION = "commit-style";
const AUTO_OPTION = "propose-message";

/** The model the user chose for a request's description (its own, else the default), without the thread's as a fallback. */
export function chosenWritingModel(preferences: PreferencesStore): ModelRef | undefined {
  return textChoice(preferences, "pr")?.model;
}

export function commitMessageModel(threadModel: ModelRef | undefined, preferences: PreferencesStore): ModelRef | undefined {
  return textChoice(preferences, "commit")?.model ?? threadModel;
}

/**
 * What a description's host command reads besides the model: the effort that
 * goes with a chosen model (the thread fallback keeps its defaults) and the
 * runtime it is written on.
 */
export function descriptionWriting(preferences: PreferencesStore): { thinkingLevel?: string; runtime?: TextChoice["runtime"] } {
  return textChoiceInput(textChoice(preferences, "pr"));
}

export function commitMessageStyle(preferences: PreferencesStore): CommitMessageStyle {
  const stored = preferences.value(REVIEW_HOST_EXTENSION_ID, STYLE_OPTION);
  return stored === "gitmoji" || stored === "plain" ? stored : "conventional";
}

/** What the user wants every commit message and request description to follow; empty when nothing. */
export function writingInstructions(preferences: PreferencesStore): string {
  return preferences.value(REVIEW_HOST_EXTENSION_ID, INSTRUCTIONS_OPTION)?.trim() ?? "";
}

/** Whether a request's description fills in the repository's template; on by default. */
export function followRequestTemplate(preferences: PreferencesStore): boolean {
  return preferences.optionValue(REVIEW_HOST_EXTENSION_ID, TEMPLATE_OPTION, true);
}

export function automaticCommitMessages(preferences: PreferencesStore): boolean {
  return preferences.optionValue(REVIEW_HOST_EXTENSION_ID, AUTO_OPTION, true);
}

/** The commit messages' model is chosen with the other texts' (`TEXT_GENERATION_OPTIONS`). */
export const COMMIT_MESSAGE_OPTIONS: ExtensionOption[] = [
  { id: AUTO_OPTION, kind: "toggle", label: "Generate a commit message when review opens", defaultValue: true },
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
    const choice = textChoice(plugin.preferences, "commit");
    const model = choice?.model ?? actions.activeThread()?.model;
    if (!model && choice?.runtime !== "thread") throw new Error("No model is selected for commit message generation.");
    const result = await plugin.host.invoke("suggest-commit-message", {
      ...(model ? { provider: model.provider, modelId: model.id } : {}),
      ...textChoiceInput(choice),
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
