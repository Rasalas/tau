import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LAUNCHER_MARKER, createCommandLine, linkFolders, renderLauncher } from "./command-line.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

/** Every folder is a temp one: nothing here may touch a real PATH directory. */
async function setup(options: { onPath?: string[]; available?: boolean; platform?: NodeJS.Platform; folders?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "tau-command-line-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  const folders = options.folders ?? [join(home, ".local", "bin"), join(home, "bin")];
  const command = createCommandLine({
    platform: options.platform ?? "linux",
    home,
    path: () => (options.onPath ?? []).join(delimiter),
    name: "tau",
    launcherDir: join(root, "data", "bin"),
    executable: "/Apps/Tau's/tau",
    entry: "/Apps/Tau/bin/tau.mjs",
    available: options.available ?? true,
    folders,
  });
  return { root, home, folders, command, launcher: join(root, "data", "bin", "tau") };
}

describe("the launcher", () => {
  it("runs the entry on the app's binary as Node, quoting both paths", () => {
    const text = renderLauncher("/Apps/Tau's/tau", "/Apps/Tau/bin/tau.mjs");
    expect(text.split("\n")).toEqual([
      "#!/bin/sh",
      `# ${LAUNCHER_MARKER}`,
      `ELECTRON_RUN_AS_NODE=1 exec '/Apps/Tau'\\''s/tau' '/Apps/Tau/bin/tau.mjs' "$@"`,
      "",
    ]);
  });

  it("offers the user's own folders first and Homebrew's only on a Mac", () => {
    expect(linkFolders("/home/a", "linux")).toEqual(["/home/a/.local/bin", "/home/a/bin"]);
    expect(linkFolders("/Users/a", "darwin")).toEqual(["/Users/a/.local/bin", "/Users/a/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
  });
});

describe("installing the tau command", () => {
  it("links the launcher into the first folder, creating it, and writes nothing else", async () => {
    const { command, folders, launcher, home } = await setup();
    const before = await command.state();
    expect(before).toMatchObject({ supported: true, name: "tau", onPath: false, target: { folder: folders[0], onPath: false } });

    const after = await command.install(folders[0]!);

    expect(after).toMatchObject({ installedPath: join(folders[0]!, "tau"), onPath: false });
    expect(await readlink(join(folders[0]!, "tau"))).toBe(launcher);
    expect(await readFile(launcher, "utf8")).toContain(LAUNCHER_MARKER);
    expect((await lstat(launcher)).mode & 0o111).not.toBe(0);
    // Only the launcher folder and the link's folder were written.
    expect(await lstat(join(home, "bin")).catch(() => undefined)).toBeUndefined();
  });

  it("prefers a writable folder that is already on PATH", async () => {
    const { command, folders, home } = await setup();
    await mkdir(folders[1]!, { recursive: true });
    const withPath = createCommandLine({
      platform: "linux", home, path: () => folders[1]!, name: "tau", launcherDir: join(home, "data"),
      executable: "/x", entry: "/y", available: true, folders,
    });
    expect((await withPath.state()).target).toEqual({ folder: folders[1], onPath: true });
    expect((await command.state()).target?.folder).toBe(folders[0]);
  });

  it("says the command is on PATH once a new terminal finds our link first", async () => {
    const { folders, home } = await setup();
    await mkdir(folders[0]!, { recursive: true });
    const command = createCommandLine({
      platform: "linux", home, path: () => folders[0]!, name: "tau", launcherDir: join(home, "data"),
      executable: "/x", entry: "/y", available: true, folders,
    });
    await command.install(folders[0]!);
    expect(await command.state()).toMatchObject({ installedPath: join(folders[0]!, "tau"), onPath: true });
  });

  it("never replaces another command of that name, and reports it", async () => {
    const { command, folders } = await setup({ onPath: [] });
    await mkdir(folders[0]!, { recursive: true });
    await writeFile(join(folders[0]!, "tau"), "#!/bin/sh\necho mine\n");

    const state = await command.state();
    expect(state.target?.folder).toBe(folders[1]);
    await expect(command.install(folders[0]!)).rejects.toThrow(/already at/u);
    expect(await readFile(join(folders[0]!, "tau"), "utf8")).toContain("echo mine");
  });

  it("reports a command earlier on PATH that would shadow the link", async () => {
    const { folders, root } = await setup();
    const other = join(root, "other");
    await mkdir(other);
    await writeFile(join(other, "tau"), "#!/bin/sh\n");
    await chmod(join(other, "tau"), 0o755);
    const shadowed = createCommandLine({
      platform: "linux", home: root, path: () => [other, folders[0]!].join(delimiter), name: "tau", launcherDir: join(root, "data"),
      executable: "/x", entry: "/y", available: true, folders,
    });
    await shadowed.install(folders[0]!);
    expect(await shadowed.state()).toMatchObject({ onPath: false, otherPath: join(other, "tau") });
  });

  it("refuses a folder it did not offer", async () => {
    const { command, root } = await setup();
    await expect(command.install(join(root, "elsewhere"))).rejects.toThrow(/not a folder Tau links into/u);
    expect(await lstat(join(root, "elsewhere")).catch(() => undefined)).toBeUndefined();
  });

  it("is unsupported in a build from source and on Windows, and writes nothing", async () => {
    for (const options of [{ available: false }, { platform: "win32" as const }]) {
      const { command, folders, root } = await setup(options);
      expect(await command.state()).toEqual({ supported: false, name: "tau", onPath: false });
      await expect(command.install(folders[0]!)).rejects.toThrow(/not installed from this build/u);
      expect(await lstat(join(root, "data")).catch(() => undefined)).toBeUndefined();
    }
  });

  it("writes the launcher again when the app moved, and repairs a link whose launcher is gone", async () => {
    const { command, folders, launcher } = await setup();
    await command.install(folders[0]!);
    await writeFile(launcher, `#!/bin/sh\n# ${LAUNCHER_MARKER}\nexec /old/place\n`);
    await command.state();
    expect(await readFile(launcher, "utf8")).toContain("/Apps/Tau/bin/tau.mjs");

    await rm(launcher);
    expect(await command.install(folders[0]!)).toMatchObject({ installedPath: join(folders[0]!, "tau") });
    expect(await readFile(launcher, "utf8")).toContain(LAUNCHER_MARKER);
  });
});

describe("removing the tau command", () => {
  it("removes our link and launcher and leaves another command alone", async () => {
    const { command, folders, launcher } = await setup();
    await command.install(folders[0]!);
    await mkdir(folders[1]!, { recursive: true });
    await writeFile(join(folders[1]!, "tau"), "not ours");

    const state = await command.remove();

    expect(state.installedPath).toBeUndefined();
    expect(await lstat(join(folders[0]!, "tau")).catch(() => undefined)).toBeUndefined();
    expect(await lstat(launcher).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(folders[1]!, "tau"), "utf8")).toBe("not ours");
  });

  it("does not delete a link that points somewhere else", async () => {
    const { command, folders, root } = await setup();
    await mkdir(folders[0]!, { recursive: true });
    await writeFile(join(root, "elsewhere"), "#!/bin/sh\n");
    await symlink(join(root, "elsewhere"), join(folders[0]!, "tau"));
    await command.remove();
    expect(await readlink(join(folders[0]!, "tau"))).toBe(join(root, "elsewhere"));
  });
});
