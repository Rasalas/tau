/** The runtime a thread gets unless another is chosen; it earns no mark of its own. */
export const DEFAULT_RUNTIME = "pi";

export interface ProviderMarks {
  model?: string;
  runtime?: string;
}

function spelling(value: string): string {
  return value.toLocaleLowerCase().replace(/[_.\s]/gu, "-");
}

/**
 * Which marks stand for a model and the runtime that runs it. A runtime is
 * shown only where it tells threads apart: never for Pi, never beside a model
 * provider of the same name. Without a model the runtime stands alone, Pi too.
 */
export function providerMarks(modelProvider: string | undefined, runtime: string | undefined): ProviderMarks {
  if (!modelProvider) return runtime ? { runtime } : {};
  if (!runtime || runtime === DEFAULT_RUNTIME || spelling(runtime) === spelling(modelProvider)) return { model: modelProvider };
  return { model: modelProvider, runtime };
}
