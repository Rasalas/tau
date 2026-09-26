import { describe, expect, it } from "vitest";
import { requestedHostWorkspace, resolveStartupWorkspace } from "./startup-workspace.js";

const recent = [
  { path: "/projects/old", lastOpenedAt: 1 },
  { path: "/projects/newer", lastOpenedAt: 3 },
  { path: "/projects/gone", lastOpenedAt: 5 },
];

describe("resolveStartupWorkspace", () => {
  it("starts in the home directory when no workspace was requested and history is empty", () => {
    expect(resolveStartupWorkspace(undefined, [], { exists: () => true, home: "/Users/me" }))
      .toEqual({ cwd: "/Users/me" });
  });

  it("starts in the most recent existing project when no workspace was requested", () => {
    const exists = (path: string) => path === "/projects/old" || path === "/projects/newer";
    expect(resolveStartupWorkspace(undefined, recent, { exists, home: "/Users/me" }))
      .toEqual({ cwd: "/projects/newer" });
  });

  it("passes over the filesystem root an app opened from the Finder once recorded", () => {
    const history = [...recent, { path: "/", lastOpenedAt: 9 }];
    const exists = (path: string) => path !== "/projects/gone";
    expect(resolveStartupWorkspace(undefined, history, { exists, home: "/Users/me" })).toEqual({ cwd: "/projects/newer" });
  });

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

describe("requestedHostWorkspace", () => {
  it("keeps a workspace somebody named", () => {
    expect(requestedHostWorkspace({ requested: "/work", service: true, windowSpawned: true, cwd: "/" })).toBe("/work");
  });

  it("takes the folder a host started by hand runs in", () => {
    expect(requestedHostWorkspace({ service: false, windowSpawned: false, cwd: "/Users/me/repo" })).toBe("/Users/me/repo");
  });

  it("leaves a service, a window's host and a host in / to the last project", () => {
    expect(requestedHostWorkspace({ service: true, windowSpawned: false, cwd: "/Users/me" })).toBeUndefined();
    expect(requestedHostWorkspace({ service: false, windowSpawned: true, cwd: "/Users/me/repo" })).toBeUndefined();
    expect(requestedHostWorkspace({ service: false, windowSpawned: false, cwd: "/" })).toBeUndefined();
  });
});
