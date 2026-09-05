import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const MODEL_REFRESH_TIMEOUT_MS = 5_000;

/** Create Pi's model runtime with bounded remote catalog refresh and persistent cache reuse. */
export function createPiModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: true,
    modelRefreshTimeoutMs: MODEL_REFRESH_TIMEOUT_MS,
  });
}
