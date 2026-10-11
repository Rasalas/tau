import type { TauConfig, ThreadBackendKind } from "./contracts.js";

/** Whether `kind` may start work in the project `config` was read for; a kind without an entry is on. */
export function runtimeEnabled(config: Pick<TauConfig, "runtimeEnabled"> | undefined, kind: ThreadBackendKind): boolean {
  return config?.runtimeEnabled?.[kind] !== false;
}

/** The kinds `config` turns off. */
export function disabledRuntimeKinds(config: Pick<TauConfig, "runtimeEnabled"> | undefined): ThreadBackendKind[] {
  return Object.entries(config?.runtimeEnabled ?? {}).flatMap(([kind, on]) => (on === false ? [kind] : []));
}

/** One entry of `runtimeEnabled`, or undefined when it is not a boolean. */
export function readRuntimeEnabledEntry(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Every valid entry of a `runtimeEnabled` record; the rest is dropped. */
export function readRuntimeEnabled(value: unknown): Record<string, boolean> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Record<string, boolean> = {};
  for (const [kind, entry] of Object.entries(value as Record<string, unknown>)) {
    if (kind.length > 0 && kind.length <= 80 && typeof entry === "boolean") result[kind] = entry;
  }
  return result;
}

/** What a refused start says; the same text on every path. */
export function runtimeOffMessage(runtimeLabel: string, projectName: string | undefined): string {
  return `${runtimeLabel} is turned off for ${projectName ? `“${projectName}”` : "this project"}. Turn it on under Settings → Providers, with Applies to set to the project.`;
}
