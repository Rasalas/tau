import type { ExtensionOption, PreferencesStore } from "tau";

/**
 * The model that writes Tau's short texts: thread titles, commit messages and
 * pull or merge request descriptions. One default holds for all three; each
 * kind may choose its own. The choices are ordinary extension values on Review
 * Kit's page (`values.tau.review.<key>`), in the shape every model option has:
 * `provider/id`, with its Pi effort beside it. Thread Titles reads them there.
 */
export type TextKind = "title" | "commit" | "pr";

/**
 * Where a text is written. `auto` is what each kind did before: a title on the
 * thread's own runtime when it offers the model, else Pi; a commit message or a
 * description on Pi. `pi` always asks Pi's models; `thread` asks the runtime of
 * the thread on screen (its login, its effort), with the chosen model when it
 * offers it and else its own.
 */
export type TextRuntime = "auto" | "pi" | "thread";

export interface ModelRef { provider: string; id: string }

/** What a kind is written with; an effort only accompanies a model chosen with it. */
export interface TextChoice {
  model?: ModelRef;
  effort?: string;
  runtime: TextRuntime;
}

/** The extension whose page holds the choices. */
export const TEXT_GENERATION_OWNER = "tau.review";

export const TEXT_KEYS = {
  default: { model: "text-model", effort: "text-effort", runtime: "text-runtime" },
  title: { model: "title-model", effort: "title-effort", runtime: "title-runtime" },
  // Review's own commit model, from before the default existed: the commit messages' choice.
  commit: { model: "commit-model", effort: "commit-effort", runtime: "commit-runtime" },
  pr: { model: "pr-model", effort: "pr-effort", runtime: "pr-runtime" },
} as const;

/** Thread Titles' own model option before the choices moved here; read until the title's is written. */
export const LEGACY_TITLE_MODEL = { extensionId: "tau.thread-titles", key: "model" } as const;

const RUNTIMES: readonly TextRuntime[] = ["auto", "pi", "thread"];

export function readTextRuntime(raw: unknown): TextRuntime {
  return RUNTIMES.includes(raw as TextRuntime) ? raw as TextRuntime : "auto";
}

/** `provider/id` as stored; anything else is no choice. */
export function parseModelRef(stored: string | undefined): ModelRef | undefined {
  const value = stored ?? "";
  const at = value.indexOf("/");
  return at > 0 && at < value.length - 1 ? { provider: value.slice(0, at), id: value.slice(at + 1) } : undefined;
}

function level(preferences: PreferencesStore, kind: TextKind | "default"): { model?: ModelRef; effort?: string; runtime: TextRuntime } {
  const keys = TEXT_KEYS[kind];
  const own = preferences.value(TEXT_GENERATION_OWNER, keys.model);
  // Undefined until written: an emptied choice ("") no longer falls back to the old option.
  const stored = own === undefined && kind === "title" ? preferences.value(LEGACY_TITLE_MODEL.extensionId, LEGACY_TITLE_MODEL.key) : own;
  const model = parseModelRef(stored);
  const effort = model ? preferences.value(TEXT_GENERATION_OWNER, keys.effort)?.trim() : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), runtime: readTextRuntime(preferences.value(TEXT_GENERATION_OWNER, keys.runtime)) };
}

/**
 * What a kind is written with: its own model, else the default's, with the
 * effort chosen beside that model; its own runtime, else the default's.
 * `undefined` when neither names a model or a runtime.
 */
export function textChoice(preferences: PreferencesStore, kind: TextKind): TextChoice | undefined {
  const own = level(preferences, kind);
  const fallback = level(preferences, "default");
  const modelLevel = own.model ? own : fallback.model ? fallback : undefined;
  const runtime = own.runtime !== "auto" ? own.runtime : fallback.runtime;
  if (!modelLevel && runtime === "auto") return undefined;
  return { ...(modelLevel?.model ? { model: modelLevel.model } : {}), ...(modelLevel?.effort ? { effort: modelLevel.effort } : {}), runtime };
}

/** The fields a host command of Review or Thread Titles reads for a choice. */
export function textChoiceInput(choice: TextChoice | undefined): { thinkingLevel?: string; runtime?: TextRuntime } {
  return {
    ...(choice?.effort ? { thinkingLevel: choice.effort } : {}),
    ...(choice && choice.runtime !== "auto" ? { runtime: choice.runtime } : {}),
  };
}

/**
 * Carries the choices made before there was a default: Thread Titles' own
 * model becomes the titles' choice, and Review's commit model, which wrote the
 * descriptions too, becomes the descriptions' choice as well. Each copy is made
 * once, while its target was never written.
 */
export function migrateTextGeneration(preferences: PreferencesStore): void {
  const value = (key: string) => preferences.value(TEXT_GENERATION_OWNER, key);
  const legacyTitle = preferences.value(LEGACY_TITLE_MODEL.extensionId, LEGACY_TITLE_MODEL.key);
  if (value(TEXT_KEYS.title.model) === undefined && parseModelRef(legacyTitle)) preferences.setValue(TEXT_GENERATION_OWNER, TEXT_KEYS.title.model, legacyTitle!);
  const commit = value(TEXT_KEYS.commit.model);
  if (value(TEXT_KEYS.pr.model) === undefined && parseModelRef(commit)) {
    preferences.setValue(TEXT_GENERATION_OWNER, TEXT_KEYS.pr.model, commit!);
    const effort = value(TEXT_KEYS.commit.effort);
    if (effort) preferences.setValue(TEXT_GENERATION_OWNER, TEXT_KEYS.pr.effort, effort);
  }
}

const RUNTIME_VALUES = [
  { value: "auto", label: "Automatic" },
  { value: "pi", label: "Pi's models" },
  { value: "thread", label: "The thread's runtime (its own effort)" },
];

/** The rows of the one place the choices are made, in the order they read. */
export const TEXT_GENERATION_OPTIONS: ExtensionOption[] = [
  { id: TEXT_KEYS.default.model, kind: "model", thinkingLevelValue: TEXT_KEYS.default.effort, label: "Model that writes titles, commit messages and descriptions", emptyLabel: "Automatic model" },
  { id: TEXT_KEYS.default.runtime, kind: "select", label: "Writes on", values: RUNTIME_VALUES, defaultValue: "auto" },
  { id: TEXT_KEYS.title.model, kind: "model", thinkingLevelValue: TEXT_KEYS.title.effort, label: "Model that names threads", emptyLabel: "Default model" },
  { id: TEXT_KEYS.title.runtime, kind: "select", label: "Thread titles write on", values: [{ value: "auto", label: "Default" }, ...RUNTIME_VALUES.slice(1)], defaultValue: "auto" },
  { id: TEXT_KEYS.commit.model, kind: "model", thinkingLevelValue: TEXT_KEYS.commit.effort, label: "Model that writes commit messages", emptyLabel: "Default model" },
  { id: TEXT_KEYS.commit.runtime, kind: "select", label: "Commit messages write on", values: [{ value: "auto", label: "Default" }, ...RUNTIME_VALUES.slice(1)], defaultValue: "auto" },
  { id: TEXT_KEYS.pr.model, kind: "model", thinkingLevelValue: TEXT_KEYS.pr.effort, label: "Model that writes pull request descriptions", emptyLabel: "Default model" },
  { id: TEXT_KEYS.pr.runtime, kind: "select", label: "Descriptions write on", values: [{ value: "auto", label: "Default" }, ...RUNTIME_VALUES.slice(1)], defaultValue: "auto" },
];
