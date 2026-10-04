import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_VISUALIZATION_BYTES, readVisualizationFragment } from "./visualization-content.js";

describe("visualization workspace reads", () => {
  it("rejects absolute paths, traversal, symlink escapes, binary data and oversized files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-visualization-"));
    const workspace = join(root, "workspace");
    try {
      await mkdir(workspace);
      await writeFile(join(workspace, "chart.html"), "<svg>chart</svg>");
      await writeFile(join(root, "secret.html"), "secret");
      await symlink(join(root, "secret.html"), join(workspace, "escape.html"));
      await writeFile(join(workspace, "binary.html"), Buffer.from([0xff]));
      await writeFile(join(workspace, "huge.html"), Buffer.alloc(MAX_VISUALIZATION_BYTES + 1));
      expect(await readVisualizationFragment(workspace, "chart.html")).toBe("<svg>chart</svg>");
      for (const path of ["../secret.html", join(root, "secret.html"), "escape.html", "a\\b", "a\0b", "binary.html", "huge.html", "."]) {
        await expect(readVisualizationFragment(workspace, path)).rejects.toThrow();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
