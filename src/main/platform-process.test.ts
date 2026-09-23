import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { batchArgument, commandInvocation, killProcessTree } from "./platform-process.js";

const windowsEnv = { ComSpec: "C:\\Windows\\system32\\cmd.exe", SystemRoot: "C:\\Windows" };

describe("commandInvocation", () => {
  it("leaves POSIX alone", () => {
    expect(commandInvocation("code", ["--goto", "a b.ts:3"], { platform: "darwin" })).toEqual({ command: "code", args: ["--goto", "a b.ts:3"] });
  });

  it("spawns a Windows .exe directly, resolved through PATHEXT", () => {
    const invocation = commandInvocation("git", ["status"], { platform: "win32", env: windowsEnv, resolve: () => "C:\\Git\\cmd\\git.exe" });
    expect(invocation).toEqual({ command: "C:\\Git\\cmd\\git.exe", args: ["status"] });
  });

  it("runs a .cmd shim through cmd.exe with a line built here", () => {
    const invocation = commandInvocation("npm", ["install", "--prefix", "C:\\Users\\me\\.tau\\npm", "pkg@1.0.0"], {
      platform: "win32",
      env: windowsEnv,
      resolve: () => "C:\\Program Files\\nodejs\\npm.cmd",
    });
    expect(invocation.command).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(invocation.args[3]).toBe(`""C:\\Program Files\\nodejs\\npm.cmd" ${batchArgument("install")} ${batchArgument("--prefix")} ${batchArgument("C:\\Users\\me\\.tau\\npm")} ${batchArgument("pkg@1.0.0")}"`);
  });

  it("takes a path to a .bat as it is and falls back to cmd.exe without ComSpec", () => {
    const invocation = commandInvocation("C:\\tools\\run.BAT", [], { platform: "win32", env: {}, resolve: () => { throw new Error("not asked"); } });
    expect(invocation).toEqual({ command: "cmd.exe", args: ["/d", "/s", "/c", "\"\"C:\\tools\\run.BAT\"\""], windowsVerbatimArguments: true });
  });

  it("keeps an unresolvable name as it is", () => {
    expect(commandInvocation("missing", ["x"], { platform: "win32", env: windowsEnv, resolve: () => undefined })).toEqual({ command: "missing", args: ["x"] });
  });
});

describe("batchArgument", () => {
  it("quotes, doubles trailing backslashes and carets every cmd.exe special", () => {
    expect(batchArgument("plain")).toBe("^\"plain^\"");
    expect(batchArgument("a b")).toBe("^\"a^ b^\"");
    expect(batchArgument("C:\\dir\\")).toBe("^\"C:\\dir\\\\^\"");
    expect(batchArgument("a&b|c>d<e^f%PATH%!x!")).toBe("^\"a^&b^|c^>d^<e^^f^%PATH^%^!x^!^\"");
  });

  it("refuses what cannot pass through cmd.exe and a batch file intact", () => {
    expect(() => batchArgument("say \"hi\"")).toThrow(/cannot take this argument/u);
    expect(() => batchArgument("two\nlines")).toThrow(/cannot take this argument/u);
  });

  /**
   * cmd.exe drops the carets when it parses the `/c` line; the batch file then
   * holds the argument in double quotes, where every special character is
   * literal, and a program reading it with the C runtime gets the original.
   */
  it("reaches the batch file quoted, and the program as it was", () => {
    const cmdParse = (text: string) => text.replace(/\^(.)/gu, "$1");
    const runtimeParse = (text: string) => {
      expect(text.startsWith("\"") && text.endsWith("\"")).toBe(true);
      return text.slice(1, -1).replace(/(\\+)$/u, (slashes: string) => slashes.slice(slashes.length / 2));
    };
    for (const arg of ["plain", "a b", "a&b", "C:\\Program Files (x86)\\x\\", "100%", "x^y", "!bang!", "=", ""]) {
      const seen = cmdParse(batchArgument(arg));
      expect(seen.slice(1, -1)).not.toContain("\"");
      expect(runtimeParse(seen)).toBe(arg);
    }
  });
});

describe("killProcessTree", () => {
  it("ends the whole tree with taskkill on Windows", () => {
    const calls: Array<[string, string[]]> = [];
    killProcessTree(4242, "SIGTERM", { platform: "win32", env: { SystemRoot: "D:\\Win" }, run: (command, args) => calls.push([command, args]) });
    expect(calls).toEqual([["D:\\Win\\System32\\taskkill.exe", ["/pid", "4242", "/T", "/F"]]]);
  });

  it("signals the process group a detached child leads on POSIX", async () => {
    if (process.platform === "win32") return;
    const child = spawn("/bin/sh", ["-c", "sleep 30 & wait"], { detached: true, stdio: "ignore" });
    await new Promise((resolve) => child.once("spawn", resolve));
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
    killProcessTree(child.pid!, "SIGTERM");
    expect(await exited).toBe("SIGTERM");
  });
});
