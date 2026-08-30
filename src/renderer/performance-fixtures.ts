import type { UiModel, UiSession } from "../shared/contracts";

/** Deterministic stress data shared by bounded navigation and picker tests. */
export const LARGE_THREAD_SHELL_FIXTURE: readonly UiSession[] = Array.from({ length: 10_000 }, (_, index) => ({
  id: `fixture-thread-${index}`,
  path: `/fixture/thread-${index}.jsonl`,
  title: `Thread ${index}`,
  modifiedAt: 1_700_000_000_000 - index,
  projectPath: `/fixture/project-${index % 20}`,
  projectName: `project-${index % 20}`,
  branch: `feature/${index % 100}`,
  messageCount: index % 40,
}));

export const LARGE_MODEL_FIXTURE: readonly UiModel[] = Array.from({ length: 10_000 }, (_, index) => ({
  provider: `provider-${index % 10}`,
  id: `model-${index}`,
  name: `Model ${index}`,
}));
