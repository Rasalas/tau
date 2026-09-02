import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertWorkspacePath } from "./workspace-git.js";

describe("host workspace paths", () => {
  it("accepts workspace paths and rejects lexical or symlink traversal", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tau-paths-"));
    const workspace = join(parent, "workspace");
    const outside = join(parent, "outside");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(workspace);
    await mkdir(outside);
    await writeFile(join(workspace, "inside.txt"), "inside");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(workspace, "escape"));
    try {
      await expect(assertWorkspacePath(workspace, "inside.txt")).resolves.toBeUndefined();
      await expect(assertWorkspacePath(workspace, "../outside/secret.txt")).rejects.toThrow("outside the workspace");
      await expect(assertWorkspacePath(workspace, "escape/secret.txt")).rejects.toThrow("outside the workspace");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
