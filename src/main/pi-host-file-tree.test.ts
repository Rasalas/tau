import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiHost } from "./pi-host.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PiHost.getFileTree", () => {
  it("shows the .scratch directory and lets the viewer load its contents", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "tau-file-tree-"));
    directories.push(workspace);
    await mkdir(join(workspace, ".scratch", "feature", "issues"), { recursive: true });
    await writeFile(join(workspace, ".scratch", "feature", "spec.md"), "# Spec\n");
    await mkdir(join(workspace, ".git"));

    const host = new PiHost(workspace, () => undefined, {} as never, true, false);

    const root = await host.getFileTree();
    expect(root.map((node) => node.name)).toContain(".scratch");
    expect(root.map((node) => node.name)).not.toContain(".git");

    const scratch = await host.getFileTree(join(workspace, ".scratch"));
    expect(scratch).toEqual([
      expect.objectContaining({ name: "feature", kind: "directory" }),
    ]);

    const feature = await host.getFileTree(join(workspace, ".scratch", "feature"));
    expect(feature.map((node) => node.name)).toEqual(["issues", "spec.md"]);
  });
});
