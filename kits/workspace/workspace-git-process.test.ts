import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertWorkspacePath, getFileDiff, runGitCommand } from "./workspace-git.js";
import { runAgentGit } from "./agent-worktrees.js";
import { storageGit } from "./worktree-storage.js";

const executable = vi.hoisted(() => vi.fn());
vi.mock("tau/host-extension", async (original) => ({
  ...await original<Record<string, unknown>>(),
  gitExecutable: executable,
}));

const folders: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  executable.mockReset();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function command(body: string) {
  const cwd = await mkdtemp(join(tmpdir(), "tau-git-process-"));
  folders.push(cwd);
  const path = join(cwd, "git-test.sh");
  await writeFile(path, `#!/bin/sh\ncount=0\nif test -f attempts; then read -r count < attempts; fi\ncount=$((count + 1))\necho "$count" > attempts\n${body}\n`);
  await chmod(path, 0o700);
  executable.mockReturnValue(path);
  return cwd;
}

describe.skipIf(process.platform === "win32")("Git process policy", () => {
  it.each([
    ["workspace", runGitCommand], ["worktrees", runAgentGit], ["storage", storageGit],
  ] as const)("disables optional locks for %s reads even when the parent enables them", async (_name, run) => {
    vi.stubEnv("GIT_OPTIONAL_LOCKS", "1");
    const cwd = await command('printf "%s" "$GIT_OPTIONAL_LOCKS"');
    expect(await run(cwd, ["status"])).toBe("0");
  });

  it.each([
    ["workspace", runGitCommand], ["worktrees", runAgentGit], ["storage", storageGit],
  ] as const)("disables repository fsmonitor commands for %s Git", async (_name, run) => {
    const cwd = await command('printf "%s\\n" "$@"');
    expect(await run(cwd, ["status"])).toContain("core.fsmonitor=false");
  });

  it("disables repository fsmonitor commands for streamed Git", async () => {
    const cwd = await command("exit 0");
    await writeFile(join(cwd, "file.txt"), "changed\n");
    await command('printf "%s\\n" "$@" > "' + join(cwd, "stream-args") + '"');
    await getFileDiff(cwd, "file.txt");
    expect(await readFile(join(cwd, "stream-args"), "utf8")).toContain("core.fsmonitor=false");
  });

  it("rejects dangling symlinks before a write can create their outside target", async () => {
    const folder = await realpath(await command("exit 0"));
    const cwd = join(folder, "workspace");
    await mkdir(cwd);
    await symlink(join(folder, "not-created"), join(cwd, "dangling"));
    await expect(assertWorkspacePath(cwd, "dangling")).rejects.toThrow();
    await expect(assertWorkspacePath(cwd, "dangling/child.txt")).rejects.toThrow();
    await expect(assertWorkspacePath(cwd, "new/child.txt")).resolves.toBeUndefined();
  });

  it("keeps the explicit environment while disabling optional locks", async () => {
    const cwd = await command('printf "%s|%s" "$GIT_OPTIONAL_LOCKS" "$TEST_GIT_VALUE"');
    expect(await runGitCommand(cwd, ["status"], undefined, undefined, {
      ...process.env, GIT_OPTIONAL_LOCKS: "1", TEST_GIT_VALUE: "kept",
    })).toBe("0|kept");
  });

  it("retries an index lock collision once and returns the successful output", async () => {
    const cwd = await command(`if test "$count" -eq 1; then
  echo "fatal: Unable to create '$PWD/.git/index.lock': File exists." >&2
  exit 128
fi
printf 'staged'`);
    expect(await runGitCommand(cwd, ["add", "--", "file.txt"])).toBe("staged");
    expect(await readFile(join(cwd, "attempts"), "utf8")).toBe("2\n");
  });

  it("stops after the second index lock collision", async () => {
    const cwd = await command(`echo "fatal: Unable to create '$PWD/.git/index.lock': File exists." >&2
exit 128`);
    await expect(runGitCommand(cwd, ["add", "--", "file.txt"])).rejects.toThrow("index.lock");
    expect(await readFile(join(cwd, "attempts"), "utf8")).toBe("2\n");
  });

  it.each([
    "fatal: Unable to create '.git/index.lock': Permission denied",
    "fatal: not a git repository",
  ])("does not retry a permanent failure: %s", async (message) => {
    const cwd = await command(`echo "${message}" >&2\nexit 128`);
    await expect(runGitCommand(cwd, ["status"])).rejects.toThrow(message);
    expect(await readFile(join(cwd, "attempts"), "utf8")).toBe("1\n");
  });
});
