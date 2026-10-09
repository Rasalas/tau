import type { UiModel } from "../shared/contracts.js";
import { priceIds } from "../shared/model-prices.js";

/** A vendor's small tier by its id: `claude-haiku-4-5`, `gpt-5-mini`, `gemini-2.5-flash`, `gpt-5.6-luna`. */
const SMALL_MODEL = /(?:^|[-_./:])(?:haiku|mini|nano|flash|lite|luna|small|tiny)(?=$|[-_./:\d])/iu;

export function isSmallModel(id: string): boolean {
  return SMALL_MODEL.test(id);
}

export interface CompletionModelRef {
  provider: string;
  id: string;
}

/** Models a runtime's own login reports it reaches; `apiModelId` is the provider's id behind an alias. */
export interface ReportedModels {
  readonly models: readonly (UiModel & { apiModelId?: string })[];
}

/** One vendor under two names: Pi names a subscription route after its provider (`openai-codex`, `google-antigravity`). */
export function sameVendor(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}-`) || right.startsWith(`${left}-`);
}

function sameModel(left: string, right: string): boolean {
  const ids = new Set(priceIds(left));
  return priceIds(right).some((id) => ids.has(id));
}

/**
 * The offers `complete` can really run. Pi lists every model it knows for a
 * provider it holds a login for, and a subscription serves fewer of them.
 * Where another runtime reports what the same vendor's subscription serves,
 * a subscription offer missing from that report is dropped; without such a
 * report Pi's list stands.
 */
export function reachableCompletionModels(offers: readonly UiModel[], reports: readonly ReportedModels[]): UiModel[] {
  const served = reports.flatMap((report) => report.models).filter((model) => model.billing === "subscription");
  return offers.filter((offer) => {
    if (offer.login !== "subscription" && offer.billing !== "subscription") return true;
    const vendor = served.filter((model) => sameVendor(model.provider, offer.provider));
    return vendor.length === 0
      || vendor.some((model) => sameModel(model.id, offer.id) || (model.apiModelId !== undefined && sameModel(model.apiModelId, offer.id)));
  });
}

function sharedPrefix(left: string, right: string): number {
  let length = 0;
  while (length < left.length && left[length] === right[length]) length += 1;
  return length;
}

function smallFamily(id: string): string {
  return SMALL_MODEL.exec(id)?.[0].replace(/^[-_./:]/u, "").toLowerCase() ?? "";
}

function compareGeneration(left: string, right: string): number {
  const version = (id: string) => (id.match(/\d+(?:[.-]\d+)*/u)?.[0] ?? "").split(/[.-]/u).filter((part) => part.length < 8).map(Number);
  const a = version(left), b = version(right);
  for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
    const difference = (b[at] ?? 0) - (a[at] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * The model for a kit's small job (a title, a branch name) when the user chose
 * none: a small model of `completionModels()`, the one closest to `prefer` —
 * the same provider first, then the same vendor under another name (a Codex
 * thread's `openai` is Pi's `openai-codex`), then the newest offered generation
 * within a small tier. Luna takes precedence over OpenAI's older mini/nano tiers.
 * `undefined` when none is small, which leaves `complete` on the user's
 * default — or, with `elsePrefer`, on `prefer` itself where `complete` runs it.
 */
export async function smallCompletionModel(
  services: { completionModels?(): Promise<UiModel[]> },
  prefer: CompletionModelRef | undefined,
  options: { elsePrefer?: boolean } = {},
): Promise<CompletionModelRef | undefined> {
  const catalog = await services.completionModels?.().catch(() => []) ?? [];
  const provider = (model: CompletionModelRef) => !prefer ? 0 : model.provider === prefer.provider ? 2 : sameVendor(model.provider, prefer.provider) ? 1 : 0;
  const closeness = (model: CompletionModelRef) => prefer ? provider(model) * 1_000 + sharedPrefix(model.id, prefer.id) : 0;
  const pick = catalog
    .filter((model) => isSmallModel(model.id))
    .sort((left, right) => {
      const vendor = provider(right) - provider(left);
      if (vendor) return vendor;
      const leftFamily = smallFamily(left.id), rightFamily = smallFamily(right.id);
      if (leftFamily === rightFamily) return compareGeneration(left.id, right.id) || closeness(right) - closeness(left);
      // Luna is OpenAI's current small tier; old mini/nano offers must not win just because the thread uses an older GPT.
      if (provider(left) > 0 && provider(right) > 0) {
        const tier = (family: string) => family === "luna" ? 3 : family === "mini" ? 2 : family === "nano" ? 1 : 0;
        const difference = tier(rightFamily) - tier(leftFamily);
        if (difference) return difference;
      }
      return closeness(right) - closeness(left);
    })[0]
    ?? (prefer && options.elsePrefer ? catalog.filter((model) => model.id === prefer.id && provider(model) > 0).sort((left, right) => provider(right) - provider(left))[0] : undefined);
  return pick ? { provider: pick.provider, id: pick.id } : undefined;
}
