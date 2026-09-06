import type { UiModel } from "../shared/contracts";

/** Deterministic stress data for the virtual list's bounded-render tests. */
export const LARGE_MODEL_FIXTURE: readonly UiModel[] = Array.from({ length: 10_000 }, (_, index) => ({
  provider: `provider-${index % 10}`,
  id: `model-${index}`,
  name: `Model ${index}`,
}));
