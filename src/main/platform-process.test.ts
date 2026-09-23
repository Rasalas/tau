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
  it("quotes, escapes quotes and trailing backslashes, and carets every cmd.exe special twice", () => {
    expect(batchArgument("plain")).toBe("^^^\"plain^^^\"");
    expect(batchArgument("a b")).toBe("^^^\"a^^^ b^^^\"");
    expect(batchArgument("C:\\dir\\")).toBe("^^^\"C:\\dir\\\\^^^\"");
    expect(batchArgument("say \"hi\"")).toBe("^^^\"say^^^ \\^^^\"hi\\^^^\"^^^\"");
    expect(batchArgument("a&b|c>d<e^f%PATH%!x!")).toBe("^^^\"a^^^&b^^^|c^^^>d^^^<e^^^^f^^^%PATH^^^%^^^!x^^^!^^^\"");
  });

  /**
   * cmd.exe drops one caret per parse, and a batch file forwarding `%*` is a
   * second parse; after both, the program must see the C-runtime quoting of the
   * original argument, with every special character literal.
   */
  it("survives both cmd.exe parses back to the original argument", () => {
    const unescapeOnce = (text: string) => text.replace(/\^(.)/gu, "$1");
    const parseQuoted = (text: string) => {
      expect(text.startsWith("\"") && text.endsWith("\"")).toBe(true);
      return text.slice(1, -1).replace(/(\\*)\\"/gu, (_all, slashes: string) => `${slashes.slice(slashes.length / 2)}"`).replace(/(\\+)$/u, (slashes: string) => slashes.slice(slashes.length / 2));
    };
    for (const arg of ["plain", "a b", "a\"&b", "C:\\Program Files (x86)\\x\\", "100%", "x^y", "!bang!", "=", ""]) {
      expect(parseQuoted(unescapeOnce(unescapeOnce(batchArgument(arg))))).toBe(arg);
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
