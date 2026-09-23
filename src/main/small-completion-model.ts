import type { UiModel } from "../shared/contracts.js";

/** A vendor's small tier by its id: `claude-haiku-4-5`, `gpt-5-mini`, `gemini-2.5-flash`, `gpt-5.6-luna`. */
const SMALL_MODEL = /(?:^|[-_./:])(?:haiku|mini|nano|flash|lite|luna|small|tiny)(?=$|[-_./:\d])/iu;

export function isSmallModel(id: string): boolean {
  return SMALL_MODEL.test(id);
}

export interface CompletionModelRef {
  provider: string;
  id: string;
}

function sharedPrefix(left: string, right: string): number {
  let length = 0;
  while (length < left.length && left[length] === right[length]) length += 1;
  return length;
}

/**
 * The model for a kit's small job (a title, a branch name) when the user chose
 * none: a small model of `completionModels()`, the one closest to `prefer` —
 * same provider (the same login) first, then the longest shared id
 * (`gpt-5.6-sol` → `gpt-5.6-luna`: a login may not reach an older generation).
 * `undefined` when none is small, which leaves `complete` on the user's default.
 */
export async function smallCompletionModel(
  services: { completionModels?(): Promise<UiModel[]> },
  prefer: CompletionModelRef | undefined,
): Promise<CompletionModelRef | undefined> {
  const catalog = await services.completionModels?.().catch(() => []) ?? [];
  const closeness = (model: CompletionModelRef) => prefer ? (model.provider === prefer.provider ? 1_000 : 0) + sharedPrefix(model.id, prefer.id) : 0;
  const pick = catalog
    .filter((model) => isSmallModel(model.id))
    .sort((left, right) => closeness(right) - closeness(left))[0];
  return pick ? { provider: pick.provider, id: pick.id } : undefined;
}
