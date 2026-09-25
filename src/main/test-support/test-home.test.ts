import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { currentTestHome } from "./test-home.js";

const real = (...parts: string[]) => join(userInfo().homedir, ...parts);

// The refusals below are what the guard is for; they must not fail this file.
afterEach(() => { currentTestHome()!.violations.splice(0); });

describe("a test file's home", () => {
  it("is a temporary folder, and Pi's agent folder is in it", () => {
    expect(homedir()).toBe(currentTestHome()!.home);
    expect(homedir().startsWith(tmpdir())).toBe(true);
    expect(getAgentDir()).toBe(join(homedir(), ".pi", "agent"));
    expect(process.env.CODEX_HOME).toBeUndefined();
  });

  it("refuses writes into the real home's tool folders, and remembers them", async () => {
    expect(() => writeFileSync(real(".tau", "tau-home-guard-probe"), "x")).toThrow(/real home/u);
    await expect(writeFile(real(".pi", "agent", "tau-home-guard-probe"), "x")).rejects.toThrow(/real home/u);
    await expect(mkdir(real(".codex", "tau-home-guard-probe"))).rejects.toThrow(/real home/u);
    expect(currentTestHome()!.violations).toHaveLength(3);
  });
});
