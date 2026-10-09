import type { RuntimeCapabilities, ThreadBackendKind } from "../shared/contracts.js";
import { PI_RUNTIME_ADAPTER, type SkillRuntimeAdapter } from "./skill-invocation.js";

/**
 * What the user lets an external runtime do; Access Kit chooses it, a backend maps it onto its own policy.
 * `auto` lets a runtime's own reviewer approve routine actions; a runtime without one asks as at `ask`.
 */
export type RuntimePermissionLevel = "read-only" | "ask" | "auto" | "full";

export interface RuntimePromptInput {
  cwd: string;
  /** Stable Tau thread key used for queues and app-data persistence. */
  tauThreadId: string;
  /** Provider-owned runtime session id; never use this as a Tau store key. */
  sessionId: string;
  text: string;
  delivery?: "prompt" | "steer" | "followUp";
  clientMessageId?: string;
  /** What the user allows the runtime to do; the transport maps it onto its own policy. */
  permissionLevel?: RuntimePermissionLevel;
  signal?: AbortSignal;
}

export interface RuntimePromptResult {
  assistantText?: string;
}

export interface RuntimeTransport {
  sendPrompt(input: RuntimePromptInput): Promise<RuntimePromptResult>;
  /** Stops children owned by one Tau thread; absent only on test transports. */
  abort?(tauThreadId: string): Promise<void>;
}

/**
 * The runtime behind a thread: Pi in process, or an external one a host
 * extension registers (ADR 0005). The id names the backend kind.
 */
export interface AgentRuntimeAdapter extends SkillRuntimeAdapter {
  readonly id: ThreadBackendKind;
  readonly capabilities: RuntimeCapabilities;
  /** External runtimes talk through a transport; Pi has none. */
  readonly transport?: RuntimeTransport;
}

/** Rejects an adapter whose shape does not fit its kind. */
export function assertRuntimeAdapter(adapter: unknown): AgentRuntimeAdapter {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("A runtime adapter configuration is required.");
  }
  const candidate = adapter as { id?: unknown; capabilities?: Partial<RuntimeCapabilities>; transport?: RuntimeTransport };
  if (typeof candidate.id !== "string" || !candidate.id) throw new Error(`Unsupported runtime adapter '${String(candidate.id)}'.`);
  if (typeof candidate.capabilities?.skillInvocationDialect !== "string") {
    throw new Error(`Runtime adapter '${candidate.id}' must declare its skill invocation dialect.`);
  }
  if (candidate.id === "pi" && candidate.capabilities.skillInvocationDialect !== "pi") {
    throw new Error("Runtime adapter 'pi' must declare the 'pi' invocation dialect.");
  }
  if (candidate.id === "pi" && candidate.transport !== undefined) {
    throw new Error("The Pi runtime adapter must not define a second transport.");
  }
  if (candidate.id !== "pi" && (!candidate.transport || typeof candidate.transport.sendPrompt !== "function")) {
    throw new Error(`The '${candidate.id}' runtime adapter requires a configured transport.`);
  }
  return adapter as AgentRuntimeAdapter;
}

export const PI_AGENT_RUNTIME_ADAPTER: AgentRuntimeAdapter = {
  id: "pi",
  capabilities: PI_RUNTIME_ADAPTER.capabilities,
};

/** Which backend a new thread gets, from the environment; safe mode always runs Pi. */
export function selectDefaultBackend(
  value: string | undefined = process.env.TAU_RUNTIME_ADAPTER,
  options: { safeMode?: boolean } = {},
): ThreadBackendKind {
  // Safe mode is a hard runtime boundary. An environment value cannot opt it
  // back into a process that bypasses Tau's extension-free startup contract.
  if (options.safeMode) return "pi";
  return value?.trim().toLowerCase() || "pi";
}
