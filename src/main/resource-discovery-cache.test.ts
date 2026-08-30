import { describe, expect, it } from "vitest";
import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { cachedResourceOptions, captureResourceDiscovery } from "./resource-discovery-cache.js";

describe("resource discovery cache", () => {
  it("reuses immutable resources without reusing an extension runtime", () => {
    const loader = {
      getSkills: () => ({ skills: [{ name: "skill" }], diagnostics: [] }),
      getPrompts: () => ({ prompts: [{ name: "prompt" }], diagnostics: [] }),
      getThemes: () => ({ themes: [{ name: "theme" }], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [{ path: "/agent", content: "agent" }] }),
      getSystemPrompt: () => "system",
      getAppendSystemPrompt: () => ["append"],
    } as unknown as ResourceLoader;
    const snapshot = captureResourceDiscovery(loader);
    const options = cachedResourceOptions(snapshot);
    expect(options.noExtensions).toBeUndefined();
    expect(options.noSkills).toBe(true);
    expect(options.skillsOverride?.({ skills: [], diagnostics: [] }).skills).toEqual([{ name: "skill" }]);
    expect(options.appendSystemPromptOverride?.([])).toEqual(["append"]);
  });
});
