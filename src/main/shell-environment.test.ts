import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { captureCommand, captureLoginShellEnvironment, findExecutable, installShellEnvironment, mergePaths, parseCapture } from "./shell-environment.js";

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
    expect(mergePaths(["/a:/b", "/b:/c", undefined, ""])).toBe("/a:/b:/c");
    expect(mergePaths([undefined])).toBeUndefined();
  });
});

describe("installShellEnvironment", () => {
  it("puts the login shell PATH first and fills missing variables only", async () => {
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

  it("reads a real shell", async () => {
    const captured = await captureLoginShellEnvironment(["PATH", "TAU_PROBE"], { shell: "/bin/sh", env: { PATH: "/usr/bin:/bin", TAU_PROBE: "yes" } });
    // A login shell may rewrite PATH (/etc/profile runs path_helper on macOS); it must still contain the system bins.
    expect(captured.PATH).toContain("/usr/bin");
    expect(captured.TAU_PROBE).toBe("yes");
  }, 15_000);
});

describe("findExecutable", () => {
  it("resolves a command on PATH and refuses non-executables", async () => {
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
