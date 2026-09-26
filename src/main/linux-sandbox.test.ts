import { describe, expect, it } from "vitest";
import { chromeSandboxProblem, type SandboxProbes } from "./linux-sandbox.js";

function probes(helper: { uid: number; mode: number } | undefined, sysctl: Record<string, string>): SandboxProbes {
  return { stat: () => helper, read: (path) => sysctl[path] };
}

const restricted = { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1" };

describe("chromeSandboxProblem", () => {
  it("names the helper and the commands when namespaces are restricted and the helper is not setuid root", () => {
    const problem = chromeSandboxProblem("/home/me/tau/tau", probes({ uid: 1000, mode: 0o100755 }, restricted));
    expect(problem?.code).toBe("chrome-sandbox");
    expect(problem?.command).toBe("sudo chown root:root '/home/me/tau/chrome-sandbox' && sudo chmod 4755 '/home/me/tau/chrome-sandbox'");
  });

  it("is fine with a setuid root helper, with user namespaces, or without a helper", () => {
    expect(chromeSandboxProblem("/opt/tau/tau", probes({ uid: 0, mode: 0o104755 }, restricted))).toBeUndefined();
    expect(chromeSandboxProblem("/opt/tau/tau", probes({ uid: 1000, mode: 0o100755 }, {}))).toBeUndefined();
    expect(chromeSandboxProblem("/opt/tau/tau", probes(undefined, restricted))).toBeUndefined();
  });
});
