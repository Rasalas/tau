import { describe, expect, it } from "vitest";
import { PiHost } from "./pi-host.js";

describe("remembering a project", () => {
  it("keeps a worktree out of the project history, so it cannot push the repository's projects out", async () => {
    const remembered: string[] = [];
    const history = { list: () => [], isHidden: () => false, iconFor: async () => undefined, remember: async (path: string) => { remembered.push(path); } };
    const host = new PiHost("/repo", () => undefined, history as never, false, false);
    const internals = host as unknown as Record<string, any>;
    internals.projects.add({ nested: async (cwd: string) => cwd.startsWith("/worktrees/") });
    await internals.rememberProject("/worktrees/fix-icons");
    await internals.rememberProject("/repo");
    expect(remembered).toEqual(["/repo"]);
  });
});
