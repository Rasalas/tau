import { describe, expect, it } from "vitest";
import { loadExternalSessionShells } from "./external-session-shells.js";
import type { HostBackendThreadRecord, HostRuntimeBackendProvider } from "./host-extensions.js";

function provider(records: HostBackendThreadRecord[], modelProvider?: string): HostRuntimeBackendProvider {
  return { kind: "antigravity", ...(modelProvider ? { modelProvider } : {}), listThreads: async () => records } as unknown as HostRuntimeBackendProvider;
}

const load = (providers: HostRuntimeBackendProvider[]) => loadExternalSessionShells({
  safeMode: false,
  providers,
  projectName: () => "repo",
  projectLabel: () => undefined,
  onError: () => undefined,
});

describe("loadExternalSessionShells", () => {
  it("names the model a thread last ran on, and the backend's provider where the record names none", async () => {
    const base = { cwd: "/repo", updatedAt: 1, messages: [{ role: "user" as const, text: "hi" }] };
    const shells = await load([provider([
      { ...base, threadId: "on-claude", model: { provider: "anthropic", id: "claude-sonnet-4-5" } },
      { ...base, threadId: "unknown" },
    ], "google")]);
    expect(shells.map(({ id, modelProvider, model }) => ({ id, modelProvider, model }))).toEqual([
      { id: "on-claude", modelProvider: "anthropic", model: "claude-sonnet-4-5" },
      { id: "unknown", modelProvider: "google", model: undefined },
    ]);
    const [bare] = await load([provider([{ ...base, threadId: "bare" }])]);
    expect(bare).not.toHaveProperty("modelProvider");
    expect(bare).not.toHaveProperty("model");
  });
});
