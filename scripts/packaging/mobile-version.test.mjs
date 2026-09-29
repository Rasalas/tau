import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { androidVersionCode, iosBuildNumber } from "./mobile-version.mjs";

const SCRIPT = new URL("./mobile-version.mjs", import.meta.url).pathname;
const GRADLE = readFileSync(new URL("../../mobile/android/app/build.gradle", import.meta.url), "utf8");

describe("the phone apps' build numbers", () => {
  it("numbers iOS builds from the run, above the nine made by hand", () => {
    expect(iosBuildNumber(1)).toBe(101);
    expect(iosBuildNumber(5)).toBeGreaterThan(9);
    expect(iosBuildNumber(6)).toBeGreaterThan(iosBuildNumber(5));
    expect(() => iosBuildNumber(0)).toThrow(/positive integer/u);
    expect(() => iosBuildNumber(Number.NaN)).toThrow(/positive integer/u);
  });

  it("derives Android's versionCode from the version, rising with every release", () => {
    expect(androidVersionCode("0.7.15")).toBe(715);
    expect(androidVersionCode("0.7.16")).toBeGreaterThan(androidVersionCode("0.7.15"));
    expect(androidVersionCode("0.8.0")).toBeGreaterThan(androidVersionCode("0.7.99"));
    expect(androidVersionCode("1.0.0")).toBeGreaterThan(androidVersionCode("0.99.99"));
    expect(() => androidVersionCode("0.7.100")).toThrow(/below 100/u);
    expect(() => androidVersionCode("next")).toThrow(/not a version/u);
  });

  it("uses the formula the Gradle build does", () => {
    expect(GRADLE).toContain("it[0] * 10000 + it[1] * 100 + it[2]");
  });

  it("answers on the command line", () => {
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    expect(run("ios-build", "--run", "7").stdout.trim()).toBe("107");
    expect(run("android-code", "--version", "1.2.3").stdout.trim()).toBe("10203");
    expect(run("ios-build").status).toBe(1);
  });
});
