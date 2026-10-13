import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCommand, installShellEnvironment } from "./shell-environment.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function cache() {
  const directory = await mkdtemp(join(tmpdir(), "tau-shell-cache-"));
  directories.push(directory);
  const cachePath = join(directory, "path.json");
  await writeFile(cachePath, JSON.stringify({ version: 1, platform: "darwin", shell: "/bin/sh", path: "/cached/bin:/usr/bin" }));
  return cachePath;
}

describe("cached shell PATH", () => {
  it("returns the last PATH before a slow rc file answers, then saves its refresh without credentials", async () => {
    const cachePath = await cache();
    const env: NodeJS.ProcessEnv = { PATH: "/inherited/bin", SHELL: "/bin/sh" };
    let answer!: (text: string) => void;
    const shell = new Promise<string>((resolve) => { answer = resolve; });
    const ready = installShellEnvironment({ cachePath, env, platform: "darwin", run: () => shell });
    let installed = false;
    void ready.then(() => { installed = true; });
    try {
      await vi.waitFor(() => expect(installed).toBe(true));
      expect(env.PATH).toBe("/cached/bin:/usr/bin:/inherited/bin");
      expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    } finally {
      const output = captureCommand(["PATH", "SSH_AUTH_SOCK"]).match(/__TAU_ENV_\w+_(?:START|END)__/gu)!;
      answer(`${output[0]}\n/fresh/bin\n${output[1]}\n${output[2]}\n/private/socket\n${output[3]}\n`);
      await ready;
    }
    await vi.waitFor(async () => expect(JSON.parse(await readFile(cachePath, "utf8"))).toMatchObject({ path: expect.stringMatching(/^\/fresh\/bin/u) }));
    expect(await readFile(cachePath, "utf8")).not.toContain("socket");
  });

  it("ignores a cache captured for another shell", async () => {
    const cachePath = await cache();
    const env: NodeJS.ProcessEnv = { PATH: "/inherited/bin", SHELL: "/bin/bash" };
    await installShellEnvironment({ cachePath, env, platform: "darwin", run: async () => "" });
    expect(env.PATH).toBe("/inherited/bin");
  });
});
