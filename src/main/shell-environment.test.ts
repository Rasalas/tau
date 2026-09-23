import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureCommand,
  captureLoginShellEnvironment,
  envValue,
  findExecutable,
  gitExecutable,
  installShellEnvironment,
  mergePaths,
  parseCapture,
  parseWindowsPathOutput,
  windowsPathScript,
} from "./shell-environment.js";

const answer = (values: Record<string, string>) => Object.entries(values)
  .map(([name, value]) => `__TAU_ENV_${name}_START__\n${value}\n__TAU_ENV_${name}_END__`)
  .join("\n");

describe("parseCapture", () => {
  it("reads values between markers and ignores rc-file noise around them", () => {
    const output = `Welcome!\n${answer({ PATH: "/opt/homebrew/bin:/usr/bin", LANG: "de_DE.UTF-8" })}\nbye\n`;
    expect(parseCapture(output, ["PATH", "LANG", "SSH_AUTH_SOCK"])).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", LANG: "de_DE.UTF-8" });
  });

  it("asks for every name with printenv", () => {
    expect(captureCommand(["PATH"])).toContain("printenv PATH || true");
  });
});

describe("mergePaths", () => {
  it("keeps the first occurrence of an entry", () => {
    expect(mergePaths(["/a:/b", "/b:/c", undefined, ""], "darwin")).toBe("/a:/b:/c");
    expect(mergePaths([undefined], "darwin")).toBeUndefined();
  });
});

const posix = process.platform !== "win32";

describe("installShellEnvironment", () => {
  // Needs a real /bin/sh to count as a login shell.
  it.runIf(posix)("puts the login shell PATH first and fills missing variables only", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", SHELL: "/bin/sh", LANG: "C" };
    const calls: string[][] = [];
    const result = await installShellEnvironment({
      env,
      platform: "darwin",
      run: async (command, args) => {
        calls.push([command, ...args]);
        return answer({ PATH: "/opt/homebrew/bin:/usr/bin", SSH_AUTH_SOCK: "/tmp/agent.sock", LANG: "de_DE.UTF-8" });
      },
    });
    expect(calls[0]?.slice(0, 2)).toEqual(["/bin/sh", "-ilc"]);
    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(env.SSH_AUTH_SOCK).toBe("/tmp/agent.sock");
    expect(env.LANG).toBe("C");
    expect(result).toEqual({ pathSource: "login-shell", installed: ["PATH", "SSH_AUTH_SOCK"] });
  });

  it("falls back to launchctl on macOS and to a UTF-8 locale when the shell answers nothing", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/sh" };
    const result = await installShellEnvironment({
      env,
      platform: "darwin",
      run: async (command) => command === "/bin/launchctl" ? "/usr/local/bin:/usr/bin\n" : "",
    });
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    expect(result.pathSource).toBe("launchctl");
  });

  it("survives a shell that fails or hangs", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/sh" };
    const result = await installShellEnvironment({ env, platform: "linux", run: async () => { throw new Error("timed out"); } });
    expect(env.PATH).toBe("/usr/bin");
    expect(result).toEqual({ pathSource: "process", installed: [] });
  });

  it.runIf(posix)("reads a real shell", async () => {
    const captured = await captureLoginShellEnvironment(["PATH", "TAU_PROBE"], { shell: "/bin/sh", env: { PATH: "/usr/bin:/bin", TAU_PROBE: "yes" } });
    // A login shell may rewrite PATH (/etc/profile runs path_helper on macOS); it must still contain the system bins.
    expect(captured.PATH).toContain("/usr/bin");
    expect(captured.TAU_PROBE).toBe("yes");
  }, 15_000);
});

describe("findExecutable", () => {
  it.runIf(posix)("resolves a command on PATH and refuses non-executables", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-path-"));
    await writeFile(join(dir, "tool"), "#!/bin/sh\n");
    await chmod(join(dir, "tool"), 0o755);
    await writeFile(join(dir, "plain"), "");
    const env = { PATH: `/nowhere:${dir}` };
    expect(findExecutable("tool", env)).toBe(join(dir, "tool"));
    expect(findExecutable("plain", env)).toBeUndefined();
    expect(findExecutable("missing", env)).toBeUndefined();
    expect(findExecutable(join(dir, "tool"), { PATH: "" })).toBe(join(dir, "tool"));
  });
});

describe("gitExecutable", () => {
  it.runIf(posix)("resolves git to an absolute path once per PATH and falls back to the bare name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-git-executable-"));
    const git = join(directory, "git");
    await writeFile(git, "#!/bin/sh\n");
    await chmod(git, 0o755);
    expect(gitExecutable({ PATH: directory })).toBe(git);
    expect(gitExecutable({ PATH: directory })).toBe(git);
    expect(gitExecutable({ PATH: join(directory, "missing") })).toBe("git");
    expect(gitExecutable({ PATH: `${join(directory, "missing")}:${directory}` })).toBe(git);
  });
});

const base64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

describe("Windows", () => {
  it("merges PATH with ; and compares entries case-, quote- and slash-insensitively", () => {
    expect(mergePaths(["C:\\Git\\cmd;C:\\Windows", "c:\\git\\CMD\\;\"C:\\Windows\";D:\\tools"], "win32"))
      .toBe("C:\\Git\\cmd;C:\\Windows;D:\\tools");
  });

  it("reads variables case-insensitively, the way Windows itself does", () => {
    expect(envValue({ Path: "C:\\bin" }, "PATH", "win32")).toBe("C:\\bin");
    expect(envValue({ Path: "/bin" }, "PATH", "darwin")).toBeUndefined();
  });

  it("parses the registry answer, CRLF and all, and keeps non-ASCII paths", () => {
    const output = `noise\r\n__TAU_PATH_Machine__${base64("C:\\Windows\\system32")}\r\n__TAU_PATH_User__${base64("C:\\Users\\Jörg\\.local\\bin")}\r\n`;
    expect(parseWindowsPathOutput(output)).toEqual({ Machine: "C:\\Windows\\system32", User: "C:\\Users\\Jörg\\.local\\bin" });
    expect(windowsPathScript()).toContain("[Environment]::GetEnvironmentVariable('Path', $scope)");
  });

  it("keeps the inherited PATH first and adds what the registry and existing tool folders have", async () => {
    const env: NodeJS.ProcessEnv = {
      Path: "C:\\Windows\\system32;C:\\venv\\Scripts",
      SystemRoot: "C:\\Windows",
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\me",
      SHELL: "/usr/bin/bash",
    };
    const calls: string[][] = [];
    const result = await installShellEnvironment({
      env,
      platform: "win32",
      directoryExists: (path) => path === "C:\\Users\\me\\AppData\\Roaming\\npm",
      run: async (command, args) => {
        calls.push([command, ...args]);
        return `__TAU_PATH_Machine__${base64("C:\\WINDOWS\\system32;C:\\Program Files\\Git\\cmd")}\r\n__TAU_PATH_User__${base64("C:\\Users\\me\\.local\\bin")}\r\n`;
      },
    });
    // No POSIX shell, even with SHELL set by a Git Bash launch; PowerShell without a profile.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calls[0]).toContain("-NoProfile");
    expect(calls[0]).toContain("-EncodedCommand");
    expect(env.Path).toBe("C:\\Windows\\system32;C:\\venv\\Scripts;C:\\Program Files\\Git\\cmd;C:\\Users\\me\\.local\\bin;C:\\Users\\me\\AppData\\Roaming\\npm");
    expect(env.PATH).toBeUndefined();
    expect(result).toEqual({ pathSource: "registry", installed: ["PATH"] });
  });

  it("leaves the environment alone when no PowerShell answers", async () => {
    const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
    const result = await installShellEnvironment({ env, platform: "win32", directoryExists: () => false, run: async () => { throw new Error("ENOENT"); } });
    expect(env).toEqual({ Path: "C:\\Windows" });
    expect(result).toEqual({ pathSource: "process", installed: [] });
  });

  it("finds a command through PATHEXT the way where.exe does, and only what can run", () => {
    const files = new Set(["C:\\Git\\cmd\\git.exe", "C:\\npm\\codex.cmd", "C:\\npm\\codex", "C:\\npm\\tool.ps1", "C:\\Program Files\\nodejs\\npm.cmd"]);
    const options = { platform: "win32" as const, isExecutable: (path: string) => files.has(path) };
    const env = { Path: "\"C:\\Program Files\\nodejs\";C:\\Git\\cmd;C:\\npm", PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.PS1" };
    expect(findExecutable("git", env, options)).toBe("C:\\Git\\cmd\\git.exe");
    // The extensionless sh launcher npm writes beside the shim is not runnable on Windows.
    expect(findExecutable("codex", env, options)).toBe("C:\\npm\\codex.cmd");
    expect(findExecutable("npm", env, options)).toBe("C:\\Program Files\\nodejs\\npm.cmd");
    expect(findExecutable("git.exe", env, options)).toBe("C:\\Git\\cmd\\git.exe");
    expect(findExecutable("tool", env, options)).toBeUndefined();
    expect(findExecutable("C:\\npm\\codex", env, options)).toBe("C:\\npm\\codex.cmd");
    expect(findExecutable("git", { Path: "C:\\Git\\cmd" }, options)).toBe("C:\\Git\\cmd\\git.exe");
  });
});

// Only a Windows runner can check these against the real file system and PowerShell.
describe.runIf(process.platform === "win32")("on a real Windows machine", () => {
  it("finds a .cmd on PATH, the way where.exe does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-pathext-"));
    await writeFile(join(dir, "tau-probe.cmd"), "@echo off\r\n");
    const found = findExecutable("tau-probe", { Path: `${dir};${process.env.PATH ?? ""}`, PATHEXT: process.env.PATHEXT });
    expect(found?.toLowerCase()).toBe(join(dir, "tau-probe.cmd").toLowerCase());
    expect(execFileSync("where.exe", ["tau-probe"], { env: { ...process.env, PATH: dir }, encoding: "utf8" }).trim().toLowerCase())
      .toBe(found?.toLowerCase());
  });

  it("reads the registry PATH through Windows PowerShell", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const result = await installShellEnvironment({ env, platform: "win32", timeoutMs: 30_000 });
    expect(result.pathSource).toBe("registry");
    expect(envValue(env, "PATH", "win32")?.toLowerCase()).toContain("system32");
  }, 60_000);
});
