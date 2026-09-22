import { describe, expect, it } from "vitest";
import { FAVOURITES_ENTRY, pickerRail, railKeyForModel } from "./model-picker-rail";

const backends = [
  { kind: "pi", label: "Pi" },
  { kind: "claude-code", label: "Claude Code" },
  { kind: "antigravity", label: "Antigravity" },
];

describe("pickerRail", () => {
  it("splits Pi's catalog by provider and gives every other runtime one tab", () => {
    const rail = pickerRail({ providers: ["anthropic", "openai-codex"], catalogRuntime: "pi", backends, favourites: true });
    expect(rail.map((entry) => entry.key)).toEqual([FAVOURITES_ENTRY, "anthropic", "openai-codex", "runtime:claude-code", "runtime:antigravity"]);
    expect(rail.filter((entry) => entry.kind === "runtime").every((entry) => entry.kind === "runtime" && !entry.listed)).toBe(true);
  });

  it("lists another runtime's catalog under its own tab and folds Pi into one", () => {
    const rail = pickerRail({ providers: ["anthropic"], catalogRuntime: "claude-code", backends, favourites: false });
    expect(rail.map((entry) => [entry.key, entry.kind === "runtime" && entry.listed])).toEqual([
      ["runtime:pi", false],
      ["runtime:claude-code", true],
      ["runtime:antigravity", false],
    ]);
  });

  it("stands alone on a host that offers only Pi", () => {
    expect(pickerRail({ providers: ["anthropic"], catalogRuntime: undefined, backends: undefined, favourites: false }).map((entry) => entry.key)).toEqual(["anthropic"]);
    expect(pickerRail({ providers: [], catalogRuntime: "pi", backends: [], favourites: false })).toEqual([
      { kind: "runtime", key: "runtime:pi", backend: { kind: "pi", label: "Pi" }, listed: true },
    ]);
  });

  it("files a model under its provider on Pi and under the runtime elsewhere", () => {
    expect(railKeyForModel("anthropic", "pi")).toBe("anthropic");
    expect(railKeyForModel("anthropic", undefined)).toBe("anthropic");
    expect(railKeyForModel("anthropic", "claude-code")).toBe("runtime:claude-code");
  });
});
