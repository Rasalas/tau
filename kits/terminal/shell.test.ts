import { describe, expect, it } from "vitest";
import { defaultShell, shellArgs } from "./shell.js";

describe("the terminal's shell", () => {
  it("takes SHELL on POSIX and starts it login-interactive", () => {
    expect(defaultShell("darwin", { SHELL: "/opt/homebrew/bin/fish" })).toBe("/opt/homebrew/bin/fish");
    expect(defaultShell("linux", {})).toBe("/bin/zsh");
    expect(shellArgs("/bin/zsh", "darwin")).toEqual(["-il"]);
  });

  it("prefers PowerShell 7, then Windows PowerShell, then ComSpec on Windows", () => {
    const env = { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
    const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    expect(defaultShell("win32", env, (name) => name === "pwsh" ? pwsh : name === powershell ? powershell : undefined)).toBe(pwsh);
    expect(defaultShell("win32", env, (name) => name === powershell ? powershell : undefined)).toBe(powershell);
    expect(defaultShell("win32", env, () => undefined)).toBe("C:\\Windows\\system32\\cmd.exe");
    expect(defaultShell("win32", {}, () => undefined)).toBe("cmd.exe");
  });

  it("drops PowerShell's banner and passes cmd.exe nothing", () => {
    expect(shellArgs("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32")).toEqual(["-NoLogo"]);
    expect(shellArgs("powershell.exe", "win32")).toEqual(["-NoLogo"]);
    expect(shellArgs("C:\\Windows\\system32\\cmd.exe", "win32")).toEqual([]);
  });
});
