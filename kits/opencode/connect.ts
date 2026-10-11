import type { OpenCodeApi } from "./api.js";
import { OpenCode1Api } from "./api-v1.js";
import { OpenCodeClient, OpenCodeHttpError, type OpenCodeClientOptions } from "./client.js";
import { OpenCode2Api, type OpenCode2ApiOptions } from "./client-v2.js";

/**
 * The implementation for the server at `url`: OpenCode 2 names its version at
 * `/api/info`; anything else is asked as OpenCode 1. (`/global/health` is no
 * test: OpenCode 2 answers it with its web page.) A rejected password throws.
 */
export async function connectOpenCodeApi(options: OpenCodeClientOptions & { api2?: OpenCode2ApiOptions }): Promise<OpenCodeApi> {
  const { api2, ...clientOptions } = options;
  const client = new OpenCodeClient(clientOptions);
  const info = await client.request<{ version?: unknown } | undefined>("GET", "/api/info", { timeoutMs: 5_000 }).catch((error: unknown) => {
    if (error instanceof OpenCodeHttpError && error.status === 401) throw error;
    return undefined;
  });
  if (typeof info?.version === "string" && info.version) return new OpenCode2Api(client, info.version, api2);
  await client.health();
  return new OpenCode1Api(client);
}
