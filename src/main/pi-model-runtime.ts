import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { withOpenCodeCatalog } from "./opencode-catalog.js";

const MODEL_REFRESH_TIMEOUT_MS = 5_000;
/** models.dev's catalog is a few megabytes; one process fetches and parses it once an hour, not once per thread. */
const CATALOG_TTL_MS = 60 * 60 * 1_000;
const CATALOG_URL = "https://models.dev/api.json";

export interface PiModelRuntimeOptions {
  /** Upper bound for the catalog refresh at start-up; a slow CI host needs more than a laptop. */
  refreshTimeoutMs?: number;
}

let catalogCache: { fetchedAt: number; catalog: Promise<unknown> } | undefined;

/** Forgets the fetched catalog; a test that serves another one calls this first. */
export function resetOpenCodeCatalogCache(): void {
  catalogCache = undefined;
}

/**
 * Starts the catalog fetch so the first thread's runtime finds it done. The
 * host calls this once at start-up; a runtime built before it lands waits, up
 * to the fetch's own bound, and one built offline never asks.
 */
export function primeOpenCodeCatalog(): void {
  if (process.env.PI_OFFLINE !== undefined) return;
  void openCodeCatalog().catch(() => undefined);
}

/**
 * The catalog, shared by every runtime the process builds. A thread switch
 * used to fetch and parse it again on the host's main thread, and that parse
 * landed as a long task inside the switch it was meant to serve.
 */
function openCodeCatalog(): Promise<unknown> {
  const now = Date.now();
  if (catalogCache && now - catalogCache.fetchedAt < CATALOG_TTL_MS) return catalogCache.catalog;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_REFRESH_TIMEOUT_MS);
  const catalog = (async () => {
    try {
      const response = await fetch(CATALOG_URL, { signal: controller.signal });
      if (!response.ok) throw new Error(`OpenCode catalog request failed: ${response.status}`);
      return await response.json() as unknown;
    } finally {
      clearTimeout(timeout);
    }
  })();
  const entry = { fetchedAt: now, catalog };
  catalogCache = entry;
  // A failed fetch is not kept; the next runtime tries again.
  catalog.catch(() => { if (catalogCache === entry) catalogCache = undefined; });
  return catalog;
}

/**
 * Create Pi's model runtime with bounded remote catalog refresh and persistent
 * cache reuse. The OpenCode providers carry models.dev's catalog as plain
 * model lists, so registering them publishes those models at once and no
 * refresh has to fetch anything for them: Pi's own unawaited refreshes after
 * `registerNativeProvider` have nothing of ours to lose.
 */
export async function createPiModelRuntime(agentDir: string, options: PiModelRuntimeOptions = {}): Promise<ModelRuntime> {
  const online = process.env.PI_OFFLINE === undefined;
  const catalog = online ? await openCodeCatalog().catch(() => undefined) : undefined;
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const providers = [opencodeGoProvider(), opencodeProvider()].map((provider) => withOpenCodeCatalog(provider, catalog));
  for (const provider of providers) runtime.registerNativeProvider(provider);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.refreshTimeoutMs ?? MODEL_REFRESH_TIMEOUT_MS);
  try {
    await runtime.refresh({ allowNetwork: online, signal: controller.signal });
    // registerNativeProvider leaves an unawaited refresh behind whose store
    // reload can land after ours and drop what we published. Recomposing the
    // provider is synchronous and idempotent, so one more pass restores it.
    const lost = providers.filter((provider) => provider.getModels().some((model) => runtime.getModel(provider.id, model.id) === undefined));
    if (lost.length > 0) await runtime.refresh({ providers: lost.map((provider) => provider.id), allowNetwork: false, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  return runtime;
}
