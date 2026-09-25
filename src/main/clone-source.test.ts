import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { assertAllowedCloneSource } from "./clone-source.js";

describe("clone source policy", () => {
  it("allows HTTPS and SSH while rejecting local and unsafe protocols", () => {
    expect(assertAllowedCloneSource("https://example.com/team/repo.git", {})).toContain("https://");
    expect(assertAllowedCloneSource("git@example.com:team/repo.git", {})).toContain("git@");
    expect(() => assertAllowedCloneSource("file:///tmp/private", {})).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource("/tmp/private", {})).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource("git://example.com/repo.git", {})).toThrow("HTTPS or SSH");
  });

  it("lets file:// through only below the test clone root", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-clone-root-"));
    mkdirSync(join(root, "origin.git"));
    const outside = mkdtempSync(join(tmpdir(), "tau-clone-outside-"));
    symlinkSync(outside, join(root, "escape"));
    const env = { TAU_TEST_CLONE_ROOT: root };
    const inside = pathToFileURL(join(root, "origin.git")).href;
    expect(assertAllowedCloneSource(inside, env)).toBe(inside);
    expect(() => assertAllowedCloneSource(inside, {})).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource(pathToFileURL(root).href, env)).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource(pathToFileURL(outside).href, env)).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource(`${pathToFileURL(root).href}/../x`, env)).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource(pathToFileURL(join(root, "escape")).href, env)).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource(inside.replace("file://", "file://elsewhere"), env)).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource(join(root, "origin.git"), env)).toThrow("HTTPS or SSH");
    expect(() => assertAllowedCloneSource(inside, { TAU_TEST_CLONE_ROOT: "relative/root" })).toThrow("HTTPS or SSH");
  });
});
