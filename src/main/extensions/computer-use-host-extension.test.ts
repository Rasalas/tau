import { describe, expect, it } from "vitest";
import { settingsIncludeComputerUse } from "./computer-use-host-extension.js";

describe("settingsIncludeComputerUse", () => {
  it("recognizes string and object package declarations", () => {
    expect(settingsIncludeComputerUse({ packages: ["npm:@amaster.ai/pi-computer-use"] })).toBe(true);
    expect(settingsIncludeComputerUse({
      packages: [{ source: "npm:@amaster.ai/pi-computer-use@0.1.12", autoload: true }],
    })).toBe(true);
  });

  it("does not confuse unrelated Pi packages with computer use", () => {
    expect(settingsIncludeComputerUse({ packages: ["npm:pi-subagents"] })).toBe(false);
    expect(settingsIncludeComputerUse({})).toBe(false);
  });
});
