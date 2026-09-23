import { describe, expect, it } from "vitest";
import { runtimeUpdate } from "./runtime-update";

describe("runtimeUpdate", () => {
  it("says a newer release is out, with the command that updates", () => {
    expect(runtimeUpdate({ kind: "codex", label: "Codex", version: { tool: "codex", installed: "0.154.0", latest: "0.155.1", updateCommand: "brew upgrade --cask codex" } }))
      .toEqual({ text: "Codex 0.155.1 is out; 0.154.0 is installed.", command: "brew upgrade --cask codex", verb: "Update with", tag: "update available" });
    expect(runtimeUpdate({ kind: "codex", label: "Codex", version: { tool: "codex", installed: "0.155.1", latest: "0.155.1" } })).toBeUndefined();
    expect(runtimeUpdate({ kind: "pi", label: "Pi" })).toBeUndefined();
  });

  it("puts a version the policy calls unsafe or broken first, with the release to install", () => {
    expect(runtimeUpdate({ kind: "codex@work", label: "Codex · Work", version: {
      tool: "codex", installed: "0.155.0", latest: "0.156.0", updateCommand: "npm install -g @openai/codex@latest",
      compatibility: { status: "unsafe", recommendedVersion: "0.160.0", installCommand: "npm install -g @openai/codex@0.160.0" },
    } })).toEqual({
      text: "Codex · Work 0.155.0 has known problems with Tau. 0.160.0 is recommended.",
      command: "npm install -g @openai/codex@0.160.0",
      verb: "Install it with",
      tag: "version has known problems",
    });
    expect(runtimeUpdate({ kind: "codex", label: "Codex", version: { tool: "codex", installed: "0.150.0", updateCommand: "brew upgrade --cask codex", compatibility: { status: "broken" } } }))
      .toEqual({ text: "Codex 0.150.0 does not work with Tau.", command: "brew upgrade --cask codex", verb: "Update with", tag: "version does not work" });
    expect(runtimeUpdate({ kind: "codex", label: "Codex", version: { tool: "codex", installed: "0.155.0", compatibility: { status: "supported" } } })).toBeUndefined();
  });
});
