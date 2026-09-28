import type { UiRuntimeBackend } from "../../shared/contracts";

/** What the bundled runtime kits declare of their marks, as the host publishes it. */
export const BUNDLED_RUNTIME_MARKS: readonly Pick<UiRuntimeBackend, "kind" | "homeProviders" | "ownPlan">[] = [
  { kind: "pi" },
  { kind: "claude-code", homeProviders: ["anthropic"] },
  { kind: "codex", homeProviders: ["openai"] },
  { kind: "antigravity", homeProviders: ["google"], ownPlan: true },
  { kind: "opencode", homeProviders: ["opencode-go"] },
  { kind: "cursor", ownPlan: true },
  { kind: "grok", homeProviders: ["xai"] },
];
