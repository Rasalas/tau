import { describe, expect, it } from "vitest";
import { resolveStartupWorkspace } from "./startup-workspace.js";

const recent = [
  { path: "/projects/old", lastOpenedAt: 1 },
  { path: "/projects/newer", lastOpenedAt: 3 },
  { path: "/projects/gone", lastOpenedAt: 5 },
];

describe("resolveStartupWorkspace", () => {
  it("keeps a workspace that exists", () => {
    const result = resolveStartupWorkspace("/work", recent, { exists: () => true });
    expect(result).toEqual({ cwd: "/work" });
  });

  it("falls back to the most recently opened project that is still on disk", () => {
    const exists = (path: string) => path === "/projects/old" || path === "/projects/newer";
    expect(resolveStartupWorkspace("/work", recent, { exists })).toEqual({ cwd: "/projects/newer", missing: "/work" });
  });

  it("skips the missing workspace itself when it is also the most recent project", () => {
    const exists = (path: string) => path === "/projects/old";
    const history = [...recent, { path: "/work", lastOpenedAt: 9 }];
    expect(resolveStartupWorkspace("/work", history, { exists })).toEqual({ cwd: "/projects/old", missing: "/work" });
  });

  it("ends in the home directory when no project exists", () => {
    expect(resolveStartupWorkspace("/work", recent, { exists: () => false, home: "/Users/me" }))
      .toEqual({ cwd: "/Users/me", missing: "/work" });
  });
});
