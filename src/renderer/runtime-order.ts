import type { UiRuntimeBackend } from "../shared/contracts";

/**
 * Items about runtimes in the host's runtime order, the one the picker and
 * onboarding show: Pi, then each backend by its `order`. An item whose
 * runtime the host does not list goes last; ties keep their order.
 */
export function inRuntimeOrder<T>(items: readonly T[], runtimeOf: (item: T) => string | undefined, backends: readonly UiRuntimeBackend[] | undefined): T[] {
  const rank = new Map((backends ?? []).map((backend, index) => [backend.kind, index]));
  const at = (item: T) => rank.get(runtimeOf(item) ?? "") ?? Number.POSITIVE_INFINITY;
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => at(a.item) - at(b.item) || a.index - b.index)
    .map(({ item }) => item);
}
