import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CUSTOMIZE_INSTRUCTIONS, customizeInstructionsFor, isTauSourceCheckout } from "./customize-instructions.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tau-customize-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function checkout(root: string, name = "@tau/kits", git: "dir" | "file" = "dir") {
  await mkdir(join(root, "kits"), { recursive: true });
  await writeFile(join(root, "kits", "package.json"), JSON.stringify({ name }));
  if (git === "dir") await mkdir(join(root, ".git"));
  else await writeFile(join(root, ".git"), "gitdir: /elsewhere\n");
}

describe("customize instructions", () => {
  it("are short and name the tools", () => {
    expect(CUSTOMIZE_INSTRUCTIONS.split("\n").length).toBeLessThanOrEqual(12);
    expect(CUSTOMIZE_INSTRUCTIONS).toContain("tau_new_package");
    expect(CUSTOMIZE_INSTRUCTIONS).toContain("tau_install_package");
    expect(CUSTOMIZE_INSTRUCTIONS).toContain("tau_window_screenshot");
  });

  it("recognise Tau's source checkout from any folder in it, and its worktrees", async () => {
    const root = await temp();
    await checkout(root);
    await mkdir(join(root, "src", "main"), { recursive: true });
    expect(isTauSourceCheckout(root)).toBe(true);
    expect(isTauSourceCheckout(join(root, "src", "main"))).toBe(true);
    const worktree = await temp();
    await checkout(worktree, "@tau/kits", "file");
    expect(isTauSourceCheckout(worktree)).toBe(true);
    expect(customizeInstructionsFor(worktree)).toBeUndefined();
  });

  it("use the cwd itself outside Git", async () => {
    const root = await temp();
    await checkout(root, "@tau/kits", "dir");
    await rm(join(root, ".git"), { recursive: true });
    expect(isTauSourceCheckout(root)).toBe(true);
  });

  it("apply to any other project, even one with a kits folder", async () => {
    const project = await temp();
    expect(customizeInstructionsFor(project)).toBe(CUSTOMIZE_INSTRUCTIONS);
    await checkout(project, "someone-elses-kits");
    expect(isTauSourceCheckout(project)).toBe(false);
    expect(customizeInstructionsFor(join(project, "kits"))).toBe(CUSTOMIZE_INSTRUCTIONS);
  });

  it("go by the Git root, not a parent that happens to hold Tau's kits", async () => {
    const outer = await temp();
    await checkout(outer);
    const inner = join(outer, "nested-project");
    await mkdir(join(inner, ".git"), { recursive: true });
    expect(isTauSourceCheckout(inner)).toBe(false);
  });
});
