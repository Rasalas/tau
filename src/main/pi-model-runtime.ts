import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { withOpenCodeCatalog } from "./opencode-catalog.js";

const MODEL_REFRESH_TIMEOUT_MS = 5_000;
/** How long the stray internal refreshes get to settle before the awaited one runs. */
const SETTLE_BUDGET_MS = 2_000;

export interface PiModelRuntimeOptions {
  /** Upper bound for the catalog refresh at start-up; a slow CI host needs more than a laptop. */
  refreshTimeoutMs?: number;
}

/** Create Pi's model runtime with bounded remote catalog refresh and persistent cache reuse. */
export async function createPiModelRuntime(agentDir: string, options: PiModelRuntimeOptions = {}): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const loadCatalog = async (signal: AbortSignal): Promise<unknown> => {
    const response = await fetch("https://models.dev/api.json", { signal });
    if (!response.ok) throw new Error(`OpenCode catalog request failed: ${response.status}`);
    return response.json();
  };
  for (const provider of [opencodeGoProvider(), opencodeProvider()]) {
    runtime.registerNativeProvider(withOpenCodeCatalog(provider, loadCatalog));
  }
  await settleRuntimeRefreshes(runtime);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.refreshTimeoutMs ?? MODEL_REFRESH_TIMEOUT_MS);
  try {
    await runtime.refresh({ allowNetwork: process.env.PI_OFFLINE === undefined, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  return runtime;
}

/**
 * registerNativeProvider and setRuntimeApiKey leave unawaited internal refreshes behind; their
 * superseded store reads abort a shared models-store reload that a later refresh joins, so the
 * last refresh's catalog publication can be lost. Drain those before the awaited refresh.
 */
async function settleRuntimeRefreshes(runtime: ModelRuntime): Promise<void> {
  // A time budget, not an attempt count: ten polls of 25 ms were not enough
  // on a loaded CI host, where the refreshes take longer to come to rest.
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  do {
    const before = await refreshSequences(runtime);
    await Promise.resolve();
    const after = await refreshSequences(runtime);
    if (sameSequences(before, after)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
}

async function refreshSequences(runtime: ModelRuntime): Promise<string> {
  const ids = runtime.getRegisteredProviderIds();
  const states = await Promise.all(
    ids.map(async (id) => `${id}:${(await runtime.checkAuth(id, {})) !== undefined ? 1 : 0}`),
  );
  return states.join("|");
}

function sameSequences(a: string, b: string): boolean {
  return a === b;
}
