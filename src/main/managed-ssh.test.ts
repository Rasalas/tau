import { describe, expect, it } from "vitest";
import { managedCli, managedSshArgs, validateSshTarget } from "./managed-ssh.js";

describe("managed SSH", () => {
  it("uses the user's SSH config with key authentication and strict known host verification", () => {
    const args = managedSshArgs("user@studio", "cat >/dev/null", ["-L", "127.0.0.1:8787:127.0.0.1:7788"]);
    expect(args).toContain("BatchMode=yes"); expect(args).toContain("StrictHostKeyChecking=yes"); expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args.at(-2)).toBe("user@studio");
  });
  it("rejects SSH options, metacharacters and remote shell injection in a target", () => {
    for (const target of ["-F/tmp/config", "studio;touch /tmp/escape", "studio$(cat secret)", "studio\nother", "user@studio's"]) expect(() => validateSshTarget(target)).toThrow();
    expect(validateSshTarget("studio")).toBe("studio");
  });
  it("uses the packaged runtime and a dedicated host data directory", () => {
    expect(managedCli("linux")).toContain("ELECTRON_RUN_AS_NODE=1");
    expect(managedCli("linux")).toContain("app.asar.unpacked/bin/tau.mjs");
    expect(managedCli("darwin")).toContain("Tau.app/Contents/MacOS/Tau");
  });
});
