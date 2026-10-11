import type { HostSnapshot, UiRuntimeBackend } from "../shared/contracts";
import type { HostClient } from "../workbench/host-client";
import type { RuntimeModels } from "./extension-system";
import { DEFAULT_RUNTIME } from "./runtime-marks";
import { runtimeCatalogStore } from "./use-runtime-catalog";

/**
 * `actions.runtimeModels`: every runtime with the catalog the host holds for
 * it, asked for as a picker would. Loaded on first use, off the initial script.
 */
export async function listRuntimeModels(client: HostClient | undefined, backends: readonly UiRuntimeBackend[] | undefined, live: HostSnapshot | undefined): Promise<RuntimeModels[]> {
  const store = runtimeCatalogStore(client);
  await store?.refresh();
  // A runtime the project turned off cannot start a thread; the one on screen stays, as it is only read.
  const listed = backends?.filter((backend) => !backend.disabled || backend.kind === (live?.backendKind ?? DEFAULT_RUNTIME));
  const offered = listed?.length ? listed : backends?.length ? backends : [{ kind: DEFAULT_RUNTIME, label: "Pi" }];
  return offered.map((backend) => {
    const entry = store?.get(backend.kind);
    const held = entry && entry.status !== "loading" ? entry.catalog : undefined;
    // A thread on screen offers what its runtime told it, which may be more than a new thread's list.
    const onScreen = live?.models.length && (live.backendKind ?? DEFAULT_RUNTIME) === backend.kind ? live : undefined;
    const catalog = onScreen ? { kind: backend.kind, thinkingLevels: {}, ...held, models: [...onScreen.models] } : held;
    return { backend, ...(catalog ? { catalog } : {}) };
  });
}
