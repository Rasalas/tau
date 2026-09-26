import { describe, expect, it } from "vitest";
import {
  apparmorProfile,
  chromeSandboxProblem,
  elevationFailure,
  renderSandboxProfile,
  sandboxProfileCommand,
  sandboxProfileName,
  sandboxProfilePath,
  type SandboxProbes,
} from "./linux-sandbox.js";

function probes(helper: { uid: number; mode: number } | undefined, files: Record<string, string>): SandboxProbes {
  return { stat: () => helper, read: (path) => files[path] };
}

const restricted = { "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1" };
const plainHelper = { uid: 1000, mode: 0o100755 };
const unpacked = "/home/me/tau/tau";

describe("chromeSandboxProblem", () => {
  it("offers the profile when namespaces are restricted and nothing allows them", () => {
    const problem = chromeSandboxProblem(unpacked, probes(plainHelper, { ...restricted, "/proc/self/attr/current": "unconfined" }));
    expect(problem?.code).toBe("chrome-sandbox");
    expect(problem?.message).toContain(`no AppArmor profile allows them for ${unpacked}`);
    expect(problem?.command).toBe("tau service install");
  });

  it("is fine with a setuid root helper, with user namespaces, or without a helper", () => {
    expect(chromeSandboxProblem("/opt/tau/tau", probes({ uid: 0, mode: 0o104755 }, restricted))).toBeUndefined();
    expect(chromeSandboxProblem("/opt/tau/tau", probes(plainHelper, {}))).toBeUndefined();
    expect(chromeSandboxProblem("/opt/tau/tau", probes(undefined, restricted))).toBeUndefined();
  });

  // What Ubuntu 24.04 shows for a process its profile attached to by path.
  it("is fine when this process runs under Tau's profile", () => {
    expect(chromeSandboxProblem("/opt/Tau/tau", probes(plainHelper, { ...restricted, "/proc/self/attr/apparmor/current": "tau (unconfined)\n" }))).toBeUndefined();
    const name = sandboxProfileName(unpacked);
    expect(chromeSandboxProblem(unpacked, probes(plainHelper, { ...restricted, "/proc/self/attr/current": `${name} (unconfined)` }))).toBeUndefined();
  });

  it("is not fooled by another profile, such as a container's", () => {
    const files = { ...restricted, "/proc/self/attr/apparmor/current": "docker-default (enforce)" };
    expect(chromeSandboxProblem("/opt/Tau/tau", probes(plainHelper, files))?.code).toBe("chrome-sandbox");
  });

  it("is fine once the profile for this path is on disk, before this process picks it up", () => {
    const files = { ...restricted, [sandboxProfilePath(unpacked)]: renderSandboxProfile(unpacked)! };
    expect(chromeSandboxProblem(unpacked, probes(plainHelper, files))).toBeUndefined();
    // One for another path, or without userns, does not count.
    const other = { ...restricted, [sandboxProfilePath(unpacked)]: renderSandboxProfile("/home/me/other/tau")! };
    expect(chromeSandboxProblem(unpacked, probes(plainHelper, other))?.code).toBe("chrome-sandbox");
    const bare = { ...restricted, [sandboxProfilePath(unpacked)]: `profile "x" "${unpacked}" {\n}\n` };
    expect(chromeSandboxProblem(unpacked, probes(plainHelper, bare))?.code).toBe("chrome-sandbox");
  });

  it("offers no fix for a path a profile cannot name", () => {
    const problem = chromeSandboxProblem("/home/me/tau*/tau", probes(plainHelper, restricted));
    expect(problem?.message).toMatch(/cannot name/u);
    expect(problem?.command).toBeUndefined();
  });
});

describe("apparmorProfile", () => {
  it("reads the label of this process, newer interface first", () => {
    expect(apparmorProfile((path) => ({ "/proc/self/attr/apparmor/current": "tau (unconfined)" })[path])).toBe("tau");
    expect(apparmorProfile((path) => ({ "/proc/self/attr/current": "snap.firefox.firefox (enforce)\0" })[path])).toBe("snap.firefox.firefox");
    expect(apparmorProfile((path) => ({ "/proc/self/attr/current": "unconfined" })[path])).toBeUndefined();
    expect(apparmorProfile(() => undefined)).toBeUndefined();
  });
});

describe("the profile", () => {
  it("is electron-builder's template for the path: userns, unconfined otherwise", () => {
    expect(sandboxProfileName("/opt/Tau/tau")).toBe("tau");
    expect(renderSandboxProfile("/opt/Tau/tau")).toBe([
      "abi <abi/4.0>,",
      "include <tunables/global>",
      "",
      'profile "tau" "/opt/Tau/tau" flags=(unconfined) {',
      "  userns,",
      "",
      "  include if exists <local/tau>",
      "}",
      "",
    ].join("\n"));
  });

  it("has a name of its own per path, so an unpacked copy and the .deb keep theirs", () => {
    const name = sandboxProfileName("/home/me/Apps/Tau 0.7.2/tau");
    expect(name).toMatch(/^tau-[0-9a-f]{12}$/u);
    expect(sandboxProfileName("/home/me/Apps/Tau 0.7.3/tau")).not.toBe(name);
    expect(renderSandboxProfile("/home/me/Apps/Tau 0.7.2/tau")).toContain(`profile "${name}" "/home/me/Apps/Tau 0.7.2/tau" flags=(unconfined) {`);
    expect(sandboxProfilePath("/home/me/Apps/Tau 0.7.2/tau")).toBe(`/etc/apparmor.d/${name}`);
  });

  it("refuses characters that would change what it attaches to", () => {
    for (const path of ['/a"b/tau', "/a\\b/tau", "/a*/tau", "/a?/tau", "/a[b]/tau", "/a{b}/tau", "/a\nb/tau", "relative/tau"]) {
      expect(renderSandboxProfile(path)).toBeUndefined();
    }
  });

  it("is written and loaded by one privileged shell, with the profile as an argument", () => {
    const pkexec = sandboxProfileCommand(unpacked, "pkexec")!;
    expect(pkexec.command).toBe("pkexec");
    expect(pkexec.args.slice(0, 3)).toEqual(["--disable-internal-agent", "/bin/sh", "-c"]);
    expect(pkexec.args.slice(-3)).toEqual(["sh", sandboxProfilePath(unpacked), renderSandboxProfile(unpacked)]);
    const script = pkexec.args[3]!;
    expect(script).toContain("apparmor_parser --skip-kernel-load --debug");
    expect(script).toContain("apparmor_parser --replace --write-cache --skip-read-cache \"$1\" || { rm -f \"$1\"; exit 1; }");
    const sudo = sandboxProfileCommand(unpacked, "sudo")!;
    expect(sudo.command).toBe("sudo");
    expect(sudo.args[0]).toBe("/bin/sh");
    expect(sandboxProfileCommand("/a*/tau", "sudo")).toBeUndefined();
  });
});

describe("elevationFailure", () => {
  it("says why the password could not be asked for, and where it can", () => {
    expect(elevationFailure("pkexec", { code: 126, stderr: "" })).toMatch(/dialog was closed/u);
    // polkit without an agent (an SSH login), and without polkitd (a container), as pkexec reports them.
    expect(elevationFailure("pkexec", { code: 127, stderr: "Error executing command as another user: No authentication agent found.\n" }))
      .toBe("No password dialog could open on this machine (Error executing command as another user: No authentication agent found): pkexec needs a polkit agent, which a desktop session has and an SSH login does not. In a terminal on this machine, run tau service install; it asks for your password with sudo.");
    expect(elevationFailure("pkexec", { code: 127, stderr: "Error getting authority: Error initializing authority: Could not connect: No such file or directory" })).toMatch(/^No password dialog could open/u);
    expect(elevationFailure("pkexec", { code: 127, stderr: "spawn pkexec ENOENT" })).toMatch(/^pkexec is not installed/u);
    expect(elevationFailure("sudo", { code: 1, stderr: "sudo: a terminal is required to read the password; either use the -S option\nsudo: a password is required" })).toMatch(/not a terminal/u);
    expect(elevationFailure("sudo", { code: 1, stderr: "Warning: unable to find a suitable fs in /proc/mounts, is it mounted?\nUse --subdomainfs to override." }))
      .toBe("Adding the AppArmor profile failed (exit 1): Use --subdomainfs to override.");
  });
});
