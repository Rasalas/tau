import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCommand, installShellEnvironment } from "./shell-environment.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function cache(miseDiff: string | null = null) {
  const directory = await mkdtemp(join(tmpdir(), "tau-shell-cache-"));
  directories.push(directory);
  const cachePath = join(directory, "path.json");
  await writeFile(cachePath, JSON.stringify({ version: 1, platform: "darwin", shell: "/bin/sh", path: "/cached/bin:/usr/bin", miseDiff }));
  return cachePath;
}

describe("cached shell PATH", () => {
  it.each([
    { miseDiff: "cached-diff", freshDiff: "fresh-diff" },
    { miseDiff: null, freshDiff: null },
  ])("returns PATH and mise record $miseDiff before a slow refresh, then saves them together", async ({ miseDiff, freshDiff }) => {
    const cachePath = await cache(miseDiff);
    const env: NodeJS.ProcessEnv = { PATH: "/inherited/bin", SHELL: "/bin/sh", __MISE_DIFF: "inherited-diff" };
    let answer!: (text: string) => void;
    const shell = new Promise<string>((resolve) => { answer = resolve; });
    const ready = installShellEnvironment({ cachePath, env, platform: "darwin", run: () => shell });
    let installed = false;
    void ready.then(() => { installed = true; });
    try {
      await vi.waitFor(() => expect(installed).toBe(true));
      expect(env.PATH).toBe("/cached/bin:/usr/bin:/inherited/bin");
      expect(env["__MISE_DIFF"]).toBe(miseDiff ?? undefined);
      expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    } finally {
      const output = captureCommand(["PATH", "SSH_AUTH_SOCK", "__MISE_DIFF"]).match(/__TAU_ENV_\w+_(?:START|END)__/gu)!;
      answer(`${output[0]}\n/fresh/bin\n${output[1]}\n${output[2]}\n/private/socket\n${output[3]}\n${output[4]}\n${freshDiff ?? ""}\n${output[5]}\n`);
      await ready;
      await vi.waitFor(async () => expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ path: "/fresh/bin:/inherited/bin" }));
    }
    await vi.waitFor(async () => expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({
      version: 1, platform: "darwin", shell: "/bin/sh", path: "/fresh/bin:/inherited/bin", miseDiff: freshDiff,
    }));
    expect(env.PATH).toBe("/fresh/bin:/inherited/bin");
    expect(env["__MISE_DIFF"]).toBe(freshDiff ?? undefined);
    expect(await readFile(cachePath, "utf8")).not.toContain("socket");
  });

  it("refreshes a legacy cache before using PATH without its mise record", async () => {
    const cachePath = await cache();
    await writeFile(cachePath, JSON.stringify({ version: 1, platform: "darwin", shell: "/bin/sh", path: "/cached/bin:/usr/bin" }));
    const env: NodeJS.ProcessEnv = { PATH: "/inherited/bin", SHELL: "/bin/sh" };
    const output = captureCommand(["PATH", "__MISE_DIFF"]).match(/__TAU_ENV_\w+_(?:START|END)__/gu)!;
    const result = await installShellEnvironment({
      cachePath, env, platform: "darwin",
      run: async () => `${output[0]}\n/fresh/bin\n${output[1]}\n${output[2]}\nfresh-diff\n${output[3]}\n`,
    });
    expect(result.pathSource).toBe("login-shell");
    expect(env.PATH).toBe("/fresh/bin:/inherited/bin");
    expect(env["__MISE_DIFF"]).toBe("fresh-diff");
  });

  it("ignores a cache captured for another shell", async () => {
    const cachePath = await cache();
    const env: NodeJS.ProcessEnv = { PATH: "/inherited/bin", SHELL: "/bin/bash" };
    await installShellEnvironment({ cachePath, env, platform: "darwin", run: async () => "" });
    expect(env.PATH).toBe("/inherited/bin");
  });
});
