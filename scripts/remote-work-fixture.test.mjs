import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRemoteWorkFixture, fixturePaths, removeRemoteWorkFixture } from "./remote-work-fixture.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("remote-work fixture", () => {
  it("makes a checkout of a local bare origin, with ignored files and an uncommitted change", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-fixture-"));
    const fixture = createRemoteWorkFixture({ root });
    expect(git(fixture.origin, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(fixture.work, "remote", "get-url", "origin")).toBe(fixture.originUrl);
    expect(fixture.originUrl.startsWith("file://")).toBe(true);
    expect(git(fixture.work, "rev-list", "--count", "HEAD")).toBe("2");
    expect(git(fixture.origin, "rev-parse", "main")).toBe(fixture.head);
    expect(fixture.branch).toBe("main");
    expect(git(fixture.work, "status", "--porcelain")).toBe("M README.md\n?? notes/");
    expect(git(fixture.work, "check-ignore", ".env", ".scratch/issues/01-fixture.md", "node_modules/left-pad/index.js").split("\n")).toHaveLength(3);
    expect(git(fixture.work, "log", "--format=%H", "-1", "--", "assets/pixel.png")).not.toBe("");
    expect(readFileSync(join(fixture.work, "assets/pixel.png"))[8]).toBe(0);
  });

  it("has the same commits every time, and --fresh starts over", () => {
    const first = createRemoteWorkFixture({ root: mkdtempSync(join(tmpdir(), "tau-fixture-")), dirty: false });
    const root = mkdtempSync(join(tmpdir(), "tau-fixture-"));
    const second = createRemoteWorkFixture({ root, dirty: false });
    expect(second.head).toBe(first.head);
    expect(git(second.work, "status", "--porcelain")).toBe("");
    createRemoteWorkFixture({ root, dirty: true });
    expect(createRemoteWorkFixture({ root, fresh: true, dirty: false }).head).toBe(first.head);
    expect(git(second.work, "status", "--porcelain")).toBe("");
    removeRemoteWorkFixture({ root });
    expect(existsSync(second.dir)).toBe(false);
  });

  it("refuses names that leave the fixture root", () => {
    for (const bad of ["../x", "a/b", "", "X"]) expect(() => fixturePaths(bad, "/r")).toThrow("fixture name");
    expect(fixturePaths("demo", "/r")).toMatchObject({ origin: "/r/demo/origin.git", work: "/r/demo/work", originUrl: "file:///r/demo/origin.git" });
  });
});
