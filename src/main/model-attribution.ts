import { randomUUID } from "node:crypto";

const OPENCODE_HOST = "opencode.ai";

function matchesHost(baseUrl: string | undefined, expectedHost: string): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname === expectedHost;
  } catch {
    return false;
  }
}

export function isOpenCodeModel(model: { provider: string; baseUrl?: string }): boolean {
  return (
    model.provider === "opencode"
    || model.provider === "opencode-go"
    || matchesHost(model.baseUrl, OPENCODE_HOST)
  );
}

export interface ModelAttribution {
  sessionId: string;
  headers?: Record<string, string>;
}

/**
 * Ensures provider attribution headers required for request routing and cache
 * affinity are present for isolated model completion requests.
 *
 * OpenCode requires `x-opencode-session` on requests sent to its endpoints.
 */
export function modelAttribution(model: { provider: string; baseUrl?: string }, sessionId: string = randomUUID()): ModelAttribution {
  const isOpencode = isOpenCodeModel(model);
  return {
    sessionId,
    ...(isOpencode ? { headers: { "x-opencode-session": sessionId, "x-opencode-client": "pi" } } : {}),
  };
}
