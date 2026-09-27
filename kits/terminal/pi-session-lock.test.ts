import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BASH_FUNCTION, PI_SESSION_LOCK_ENV, piShellEnvironment, writePiShellIntegration } from "./pi-session-lock.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function which(name: string): string | undefined {
  const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() || undefined : undefined;
}

/** A home with a fake `pi` that prints its arguments, and the integration files. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "tau-pi-shell-"));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "pi"), "#!/bin/sh\necho \"pi-args:$*\"\n");
  chmodSync(join(bin, "pi"), 0o755);
  const extension = join(root, "pi-session-lock-extension.js");
  writeFileSync(extension, "export default function () {}\n");
  const integration = join(root, "integration");
  expect(writePiShellIntegration(integration)).toBe(true);
  return { root, home, bin, extension, integration };
}

function runShell(shell: string, args: string[], env: Record<string, string>, input: string): string {
  return execFileSync(shell, args, { env, input, encoding: "utf8", timeout: 20_000 });
}

const lines = (output: string) => output.split("\n").filter((line) => line.startsWith("pi-args:"));

describe("piShellEnvironment", () => {
  it("adds nothing when the host names no extension, or for a shell without a way in", () => {
    expect(piShellEnvironment("/bin/zsh", {}, "/int", "darwin")).toEqual({});
    const env = { [PI_SESSION_LOCK_ENV]: "/ext.js" };
    expect(piShellEnvironment("/bin/sh", env, "/int", "linux")).toEqual({});
    expect(piShellEnvironment("pwsh.exe", env, "C:\\int", "win32")).toEqual({});
  });

  it("points zsh at Tau's first startup file and keeps the user's ZDOTDIR for the rest", () => {
    const env = { [PI_SESSION_LOCK_ENV]: "/ext.js" };
    expect(piShellEnvironment("/bin/zsh", env, "/int", "darwin")).toEqual({ ZDOTDIR: "/int/zsh" });
    expect(piShellEnvironment("/bin/zsh", { ...env, ZDOTDIR: "/me/.config/zsh" }, "/int", "darwin"))
      .toEqual({ ZDOTDIR: "/int/zsh", TAU_USER_ZDOTDIR: "/me/.config/zsh" });
  });

  it("exports a bash function and prefixes fish's data dirs without losing the defaults", () => {
    const env = { [PI_SESSION_LOCK_ENV]: "/ext.js" };
    expect(piShellEnvironment("/usr/bin/bash", env, "/int", "linux")).toEqual({ "BASH_FUNC_pi%%": BASH_FUNCTION });
    expect(piShellEnvironment("/usr/bin/fish", env, "/int", "linux")).toEqual({ XDG_DATA_DIRS: "/int/xdg:/usr/local/share:/usr/share" });
    expect(piShellEnvironment("/usr/bin/fish", { ...env, XDG_DATA_DIRS: "/nix/share" }, "/int", "linux")).toEqual({ XDG_DATA_DIRS: "/int/xdg:/nix/share" });
  });
});

describe("pi in a shell of Tau's terminal", () => {
  const zsh = which("zsh");
  const bash = which("bash");
  const fish = which("fish");

  it.skipIf(!zsh)("zsh: loads the lock extension, leaves Pi's own commands alone, and still reads the user's files", () => {
    const box = sandbox();
    const userDir = join(box.home, "zdot");
    mkdirSync(userDir);
    writeFileSync(join(userDir, ".zshenv"), "export USER_ZSHENV=read\n");
    writeFileSync(join(userDir, ".zprofile"), "export USER_ZPROFILE=read\n");
    // System startup files may reset PATH; the user's rc puts their bin first, as rc files do.
    writeFileSync(join(userDir, ".zshrc"), `path=(${box.bin} $path)\necho "rc:$ZDOTDIR"\n`);
    const base = { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, [PI_SESSION_LOCK_ENV]: box.extension, ZDOTDIR: userDir };
    const env = { ...base, ...piShellEnvironment(zsh!, base, box.integration) } as Record<string, string>;
    // Login and interactive, as the terminal starts it (shellArgs).
    const output = runShell(zsh!, ["-il"], env, "pi hello there\npi install npm:x\necho \"env:$USER_ZSHENV $USER_ZPROFILE\"\nexit\n");

    expect(lines(output)).toEqual([`pi-args:-e ${box.extension} hello there`, "pi-args:install npm:x"]);
    expect(output).toContain(`rc:${userDir}`);
    expect(output).toContain("env:read read");
  });

  it.skipIf(!zsh)("zsh: a pi the user defined wins", () => {
    const box = sandbox();
    writeFileSync(join(box.home, ".zshrc"), "pi() { echo \"pi-args:mine $*\"; }\n");
    const base = { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, [PI_SESSION_LOCK_ENV]: box.extension };
    const env = { ...base, ...piShellEnvironment(zsh!, base, box.integration) } as Record<string, string>;
    expect(lines(runShell(zsh!, ["-i"], env, "pi hello\nexit\n"))).toEqual(["pi-args:mine hello"]);
  });

  it.skipIf(!bash)("bash: the exported function loads the extension", () => {
    const box = sandbox();
    const base = { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, [PI_SESSION_LOCK_ENV]: box.extension };
    const env = { ...base, ...piShellEnvironment(bash!, base, box.integration) } as Record<string, string>;
    expect(lines(runShell(bash!, ["--noprofile", "--norc", "-i"], env, "pi hello\npi update\nexit\n")))
      .toEqual([`pi-args:-e ${box.extension} hello`, "pi-args:update"]);
  });

  it.skipIf(!fish)("fish: the vendor function loads the extension", () => {
    const box = sandbox();
    const base = { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, [PI_SESSION_LOCK_ENV]: box.extension, XDG_CONFIG_HOME: join(box.home, ".config") };
    const env = { ...base, ...piShellEnvironment(fish!, base, box.integration) } as Record<string, string>;
    expect(lines(runShell(fish!, ["-c", "pi hello; pi list"], env, "")))
      .toEqual([`pi-args:-e ${box.extension} hello`, "pi-args:list"]);
  });

  it.skipIf(!bash)("falls back to the plain pi when the extension file is gone", () => {
    const box = sandbox();
    rmSync(box.extension);
    const env = { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, [PI_SESSION_LOCK_ENV]: box.extension, "BASH_FUNC_pi%%": BASH_FUNCTION };
    expect(lines(runShell(bash!, ["--noprofile", "--norc", "-c", "pi hello"], env, ""))).toEqual(["pi-args:hello"]);
    expect(readFileSync(join(box.integration, "zsh", ".zshenv"), "utf8")).toContain("add-zsh-hook");
  });
});
