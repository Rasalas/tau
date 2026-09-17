import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { withOpenCodeCatalog } from "./opencode-catalog.js";

const MODEL_REFRESH_TIMEOUT_MS = 5_000;

/** Create Pi's model runtime with bounded remote catalog refresh and persistent cache reuse. */
export async function createPiModelRuntime(agentDir: string): Promise<ModelRuntime> {
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
  const timeout = setTimeout(() => controller.abort(), MODEL_REFRESH_TIMEOUT_MS);
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
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const before = await refreshSequences(runtime);
    await Promise.resolve();
    const after = await refreshSequences(runtime);
    if (sameSequences(before, after)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
