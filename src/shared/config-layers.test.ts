import { describe, expect, it } from "vitest";
import { isPiOwnedSetting, layerValue, resolveSetting, settingPath, settingWritable, withSetting, withoutSetting, type ConfigLayers } from "./config-layers.js";

describe("setting keys", () => {
  it("splits only record keys, at the first dot", () => {
    expect(settingPath("showCosts")).toEqual(["showCosts"]);
    expect(settingPath("values.tau.appearance.density")).toEqual(["values", "tau.appearance.density"]);
    expect(settingPath("threads.continueAfterRestart")).toEqual(["threads", "continueAfterRestart"]);
    expect(settingPath("updates.channel")).toEqual(["updates", "channel"]);
    expect(settingPath("theme.dark")).toEqual(["theme.dark"]);
  });

  it("knows the keys Pi owns", () => {
    expect(isPiOwnedSetting("compaction")).toBe(true);
    expect(isPiOwnedSetting("showCosts")).toBe(false);
  });

  it("sets and removes a key without touching the rest of the level", () => {
    const level = withSetting({ values: { "a.b": "1" }, showCosts: true }, "values.a.c", "2");
    expect(level).toEqual({ values: { "a.b": "1", "a.c": "2" }, showCosts: true });
    expect(layerValue(level, "values.a.c")).toBe("2");
    expect(withoutSetting(withoutSetting(level, "values.a.b"), "values.a.c")).toEqual({ showCosts: true });
    expect(withoutSetting(level, "showCosts")).toEqual({ values: { "a.b": "1", "a.c": "2" } });
  });
});

describe("resolving a setting across the levels", () => {
  const layers: ConfigLayers = {
    host: { showCosts: false, values: { "tau.appearance.density": "compact" } },
    project: { values: { "tau.appearance.density": "comfortable" } },
    projectPath: "/work/app",
  };

  it("takes the project's value first, then the host's, then the default", () => {
    const density = resolveSetting(layers, "values.tau.appearance.density", "normal", "project");
    expect(density.value).toBe("comfortable");
    expect(density.origin).toBe("project");
    expect(density.chain.map((entry) => [entry.layer, entry.set, entry.effective])).toEqual([
      ["project", true, true], ["host", true, false], ["default", true, false],
    ]);

    const costs = resolveSetting(layers, "showCosts", true, "project");
    expect(costs).toMatchObject({ value: false, origin: "host" });

    const detail = resolveSetting(layers, "transcriptDetail", "focused", "project");
    expect(detail).toMatchObject({ value: "focused", origin: "default" });
  });

  it("shows the host's value while the host is edited, and names the project that hides it", () => {
    const density = resolveSetting(layers, "values.tau.appearance.density", "normal", "host");
    expect(density.value).toBe("compact");
    expect(density.origin).toBe("host");
    expect(density.chain.map((entry) => entry.layer)).toEqual(["host", "default"]);
    expect(density.projectOverride).toBe("comfortable");
    expect(resolveSetting(layers, "showCosts", true, "host").projectOverride).toBeUndefined();
  });

  it("skips a value its reader does not accept", () => {
    const odd: ConfigLayers = { host: { values: { "x.size": "huge" } } };
    const size = resolveSetting(odd, "values.x.size", 13, "host", (raw) => (typeof raw === "string" && /^\d+$/u.test(raw) ? Number(raw) : undefined));
    expect(size).toMatchObject({ value: 13, origin: "default" });
  });

  it("writes a setting only to the levels its scope names", () => {
    expect(settingWritable("both", "project")).toBe(true);
    expect(settingWritable("host", "project")).toBe(false);
    expect(settingWritable("project", "host")).toBe(false);
  });
});
