import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_OOM_SCORE_ADJ,
  AGENT_SLICE,
  AgentScopes,
  agentScopeCommand,
  agentShellScript,
  agentSliceMemoryLimits,
  classifyScope,
  parseCgroupCounter,
  parseKeyValues,
  type AgentScopeSetup,
  type AgentScopeSystem,
  type ScopeRun,
} from "./agent-scope.js";

const GiB = 1024 ** 3;
const ok: ScopeRun = { code: 0, stdout: "", stderr: "" };

interface FakeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  memory?: number;
  /** Commands that resolve, by name. */
  commands?: Record<string, string>;
  /** Answers of `systemd-run` probes: with the OOM policy first, then without. */
  probes?: Array<ScopeRun | undefined>;
  limits?: ScopeRun | undefined;
  /** Successive `systemctl show` answers for the scope. */
  shown?: string[];
  files?: Record<string, string>;
}

function fakeSystem(options: FakeOptions = {}) {
  const calls: Array<{ command: string; args: readonly string[]; async: boolean }> = [];
  const warnings: string[] = [];
  const probes = [...(options.probes ?? [ok])];
  const shown = [...(options.shown ?? [])];
  let id = 0;
  const system: AgentScopeSystem = {
    platform: options.platform ?? "linux",
    env: options.env ?? { XDG_RUNTIME_DIR: "/run/user/1000", PATH: "/usr/bin" },
    totalMemory: () => options.memory ?? 16 * GiB,
    resolve: (command) => (command.startsWith("/") ? command : (options.commands ?? { "systemd-run": "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", codex: "/usr/bin/codex" })[command]),
    run: (command, args) => {
      calls.push({ command, args, async: false });
      if (args.includes("set-property")) return "limits" in options ? options.limits : ok;
      return probes.shift();
    },
    runAsync: async (command, args) => {
      calls.push({ command, args, async: true });
      if (args.includes("show")) return { code: 0, stdout: shown.shift() ?? shown.at(-1) ?? "", stderr: "" };
      return ok;
    },
    readFile: async (path) => options.files?.[path] ?? Promise.reject(new Error("missing")),
    sleep: async () => undefined,
    newId: () => String(++id).padStart(8, "0"),
    warn: (message) => warnings.push(message),
  };
  return { system, calls, warnings };
}

const setup: AgentScopeSetup = { systemdRun: "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl", runtimeDir: "/run/user/1000", options: ["--property=OOMPolicy=stop"] };

describe("agentSliceMemoryLimits", () => {
  it("leaves 6 GB before throttling and 4 GB before a kill on a large machine", () => {
    expect(agentSliceMemoryLimits(64 * GiB)).toEqual({ high: 58 * GiB, max: 60 * GiB });
  });

  it("gives agents at least half and three quarters of a small machine", () => {
    expect(agentSliceMemoryLimits(8 * GiB)).toEqual({ high: 4 * GiB, max: 6 * GiB });
    expect(agentSliceMemoryLimits(4 * GiB)).toEqual({ high: 2 * GiB, max: 3 * GiB });
  });
});

describe("agentScopeCommand", () => {
  it("raises the score and execs the command with its own arguments when there is no user manager", () => {
    expect(agentScopeCommand({ command: "/usr/bin/codex", args: ["app-server", "a b"] })).toEqual({
      command: "/bin/sh",
      args: ["-c", expect.stringContaining(`echo ${AGENT_OOM_SCORE_ADJ} >/proc/self/oom_score_adj`), "tau-agent", "/usr/bin/codex", "app-server", "a b"],
    });
  });

  it("puts systemd-run in front of the command, in the slice, with its options and the command after a double dash", () => {
    const launch = agentScopeCommand({ command: "/usr/bin/codex", args: ["app-server"], scope: { setup, unit: "tau-codex-1.scope" } });
    expect(launch.command).toBe("/bin/sh");
    expect(launch.args.slice(2)).toEqual([
      "tau-agent", "/run/user/1000", "/usr/bin/systemd-run",
      "--user", "--scope", "--quiet", `--slice=${AGENT_SLICE}`, "--unit=tau-codex-1.scope", "--property=OOMPolicy=stop",
      "--", "/usr/bin/codex", "app-server",
    ]);
    expect(launch.args).not.toContain("--collect");
  });

  it("collects a scope nobody reads", () => {
    expect(agentScopeCommand({ command: "x", args: [], scope: { setup, unit: "u.scope", collect: true } }).args).toContain("--collect");
  });

  it("omits the OOM policy on a systemd without it", () => {
    const launch = agentScopeCommand({ command: "x", args: [], scope: { setup: { ...setup, options: [] }, unit: "u.scope" } });
    expect(launch.args.some((arg) => arg.startsWith("--property="))).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("the launch script", () => {
  it("runs the command as the spawned process with its arguments intact and the raised score", () => {
    const launch = agentScopeCommand({ command: "/bin/sh", args: ["-c", 'printf "%s\\n" "$$" "$(cat /proc/self/oom_score_adj)" "$@"', "agent", "a b", "$HOME"] });
    const child = spawnSync(launch.command, launch.args, { encoding: "utf8" });
    const [pid, score, ...args] = child.stdout.trimEnd().split("\n");
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);
  });
});

describe("the exec chain with a fake systemd-run", () => {
  it("keeps the PID, the arguments and the runtime directory through both shells", () => {
    const directory = mkdtempSync(join(tmpdir(), "fake-run-"));
    try {
      const fake = join(directory, "systemd-run");
      writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
      chmodSync(fake, 0o755);
      const launch = agentScopeCommand({
        command: "/bin/sh",
        args: ["-c", 'printf "%s\\n" "$$" "$XDG_RUNTIME_DIR" "$1" "$2"', "agent", "a b", "$HOME"],
        scope: { setup: { ...setup, systemdRun: fake }, unit: "u.scope" },
      });
      const child = spawnSync(launch.command, launch.args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
      expect(child.stdout.trimEnd().split("\n")).toEqual([String(child.pid), "/run/user/1000", "a b", "$HOME"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("parsing", () => {
  it("reads key=value lines and cgroup counters", () => {
    expect(parseKeyValues("LoadState=loaded\nResult=oom-kill\nControlGroup=/a/b=c\n").get("ControlGroup")).toBe("/a/b=c");
    expect(parseCgroupCounter("low 0\noom_kill 3\n", "oom_kill")).toBe(3);
    expect(parseCgroupCounter("populated 0\n", "oom_kill")).toBeUndefined();
  });

  it("classifies a scope as its agent exits", () => {
    const state = { loadState: "loaded", activeState: "active", result: "success", oomKills: 0, populated: true };
    expect(classifyScope({ ...state, activeState: "failed", result: "oom-kill" })).toBe("oom-killed");
    expect(classifyScope({ ...state, loadState: "not-found" })).toBe("gone");
    expect(classifyScope({ ...state, activeState: "inactive" })).toBe("gone");
    expect(classifyScope({ ...state, activeState: "deactivating" })).toBe("stopping");
    expect(classifyScope({ ...state, oomKills: 1 })).toBe("stopping");
    expect(classifyScope({ ...state, populated: false })).toBe("stopping");
    expect(classifyScope(state)).toBe("running");
  });
});

describe("AgentScopes probe", () => {
  it("is off on macOS and Windows and never runs anything", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const { system, calls } = fakeSystem({ platform });
      const scopes = new AgentScopes(system);
      expect(scopes.wrap({ command: "agent", args: ["--x"], name: "agent" })).toEqual({ command: "agent", args: ["--x"] });
      expect(scopes.scopeSetup()).toBeUndefined();
      expect(calls).toEqual([]);
    }
  });

  it("is off without a runtime directory, and the command only gets the raised score", () => {
    const { system, calls } = fakeSystem({ env: { PATH: "/usr/bin" } });
    const launch = new AgentScopes(system).wrap({ command: "codex", args: ["x"], name: "codex" });
    expect(calls).toEqual([]);
    expect(launch.scope).toBeUndefined();
    expect(launch.command).toBe("/bin/sh");
    expect(launch.args.slice(3)).toEqual(["/usr/bin/codex", "x"]);
  });

  it("is off when systemd-run or systemctl is missing", () => {
    const { system, calls } = fakeSystem({ commands: { "systemd-run": "/usr/bin/systemd-run", codex: "/usr/bin/codex" } });
    expect(new AgentScopes(system).scopeSetup()).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("is off when the user manager refuses both probes", () => {
    const { system, calls } = fakeSystem({ probes: [{ code: 1, stdout: "", stderr: "Failed to connect to bus" }, { code: 1, stdout: "", stderr: "" }] });
    const scopes = new AgentScopes(system);
    expect(scopes.scopeSetup()).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("is off when systemd-run cannot start at all", () => {
    expect(new AgentScopes(fakeSystem({ probes: [undefined, undefined] }).system).scopeSetup()).toBeUndefined();
  });

  it("turns scopes on with the OOM policy and sets the slice limits at runtime", () => {
    const { system, calls } = fakeSystem({ memory: 32 * GiB });
    expect(new AgentScopes(system).scopeSetup()).toEqual(setup);
    expect(calls.map((call) => [call.command, ...call.args])).toEqual([
      ["/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--collect", `--slice=${AGENT_SLICE}`, "--property=OOMPolicy=stop", "--", "true"],
      ["/usr/bin/systemctl", "--user", "set-property", "--runtime", AGENT_SLICE, `MemoryHigh=${26 * GiB}`, `MemoryMax=${28 * GiB}`],
    ]);
  });

  it("falls back to plain scopes on a systemd older than 253", () => {
    const { system, calls } = fakeSystem({ probes: [{ code: 1, stdout: "", stderr: "Unknown assignment OOMPolicy" }, ok] });
    const scopes = new AgentScopes(system);
    expect(scopes.scopeSetup()).toEqual({ ...setup, options: [] });
    expect(calls[1]!.args).not.toContain("--property=OOMPolicy=stop");
    expect(scopes.wrap({ command: "codex", args: [], name: "codex" }).args.some((arg) => arg.startsWith("--property="))).toBe(false);
  });

  it("probes once, even when it came out off", () => {
    const { system, calls } = fakeSystem({ probes: [{ code: 1, stdout: "", stderr: "" }, { code: 1, stdout: "", stderr: "" }] });
    const scopes = new AgentScopes(system);
    scopes.wrap({ command: "codex", args: [], name: "codex" });
    scopes.wrap({ command: "codex", args: [], name: "codex" });
    expect(calls).toHaveLength(2);
  });

  it("keeps scopes on when the limits cannot be set", () => {
    const { system, warnings } = fakeSystem({ limits: { code: 1, stdout: "", stderr: "denied" } });
    expect(new AgentScopes(system).scopeSetup()).toEqual(setup);
    expect(warnings).toEqual(["Could not set memory limits on the agents slice"]);
  });
});

describe("AgentScopes.wrap", () => {
  it("leaves a command that does not resolve unwrapped", () => {
    const { system, calls } = fakeSystem();
    const launch = new AgentScopes(system).wrap({ command: "missing-agent", args: ["--x"], name: "agent" });
    expect(launch).toEqual({ command: "missing-agent", args: ["--x"] });
    expect(calls).toEqual([]);
  });

  it("resolves the command against the environment the agent runs with", () => {
    const { system } = fakeSystem({ commands: { "systemd-run": "/usr/bin/systemd-run", systemctl: "/usr/bin/systemctl" } });
    const resolved: Array<string | undefined> = [];
    const scopes = new AgentScopes({ ...system, resolve: (command, env) => { resolved.push(env.PATH); return system.resolve(command, env) ?? "/custom/agent"; } });
    expect(scopes.wrap({ command: "agent", args: [], name: "agent", env: { PATH: "/custom" } }).args).toContain("/custom/agent");
    expect(resolved).toContain("/custom");
  });

  it("names each scope after the agent and gives it a handle", () => {
    const { system } = fakeSystem();
    const scopes = new AgentScopes(system);
    const first = scopes.wrap({ command: "codex", args: ["app-server"], name: "co dex!" });
    const second = scopes.wrap({ command: "codex", args: ["app-server"], name: "codex" });
    expect(first.scope?.unit).toBe("tau-codex-00000001.scope");
    expect(second.scope?.unit).toBe("tau-codex-00000002.scope");
    expect(first.args).toContain("--unit=tau-codex-00000001.scope");
    expect(first.args.slice(-3)).toEqual(["--", "/usr/bin/codex", "app-server"]);
  });

  it("collects the scope of a launch nobody will ask about", () => {
    const launch = new AgentScopes(fakeSystem().system).wrap({ command: "codex", args: [], name: "codex", collect: true });
    expect(launch.args).toContain("--collect");
    expect(launch.scope).toBeUndefined();
  });
});

describe("AgentScopes OOM label", () => {
  const unit = "tau-codex-00000001.scope";
  const show = (values: Record<string, string>) => Object.entries({ LoadState: "loaded", ActiveState: "active", Result: "success", ControlGroup: "", ...values }).map(([key, value]) => `${key}=${value}`).join("\n");

  function launch(shown: string[], files: Record<string, string> = {}) {
    const fake = fakeSystem({ shown, files });
    const handle = new AgentScopes(fake.system).wrap({ command: "codex", args: [], name: "codex" }).scope!;
    return { ...fake, handle };
  }

  it("says yes when the scope recorded oom-kill, and resets the failed unit once", async () => {
    const { handle, calls } = launch([show({ ActiveState: "failed", Result: "oom-kill" })]);
    expect(handle.unit).toBe(unit);
    expect(await handle.oomKilled()).toBe(true);
    expect(await handle.oomKilled()).toBe(true);
    const resets = calls.filter((call) => call.args.includes("reset-failed"));
    expect(resets).toHaveLength(1);
    expect(resets[0]!.args).toEqual(["--user", "reset-failed", unit]);
  });

  it("waits while the scope is still stopping", async () => {
    const { handle } = launch([show({ ActiveState: "deactivating" }), show({ ActiveState: "deactivating" }), show({ ActiveState: "failed", Result: "oom-kill" })]);
    expect(await handle.oomKilled()).toBe(true);
  });

  it("sees a kill the cgroup counted before systemd recorded it", async () => {
    const { handle } = launch(
      [show({ ControlGroup: "/user.slice/x.scope" }), show({ ActiveState: "failed", Result: "oom-kill" })],
      { "/sys/fs/cgroup/user.slice/x.scope/memory.events": "oom_kill 1\n" },
    );
    expect(await handle.oomKilled()).toBe(true);
  });

  it("says no for an agent that ended on its own", async () => {
    const { handle, calls } = launch([show({ ActiveState: "inactive" })]);
    expect(await handle.oomKilled()).toBe(false);
    expect(calls.some((call) => call.args.includes("reset-failed"))).toBe(false);
  });

  it("says no for a scope that failed for another reason, and still resets it", async () => {
    const { handle, calls } = launch([show({ ActiveState: "failed", Result: "timeout" })]);
    expect(await handle.oomKilled()).toBe(false);
    expect(calls.some((call) => call.args.includes("reset-failed"))).toBe(true);
  });

  it("says no when the scope still runs or cannot be read", async () => {
    expect(await launch([show({})]).handle.oomKilled()).toBe(false);
    const fake = fakeSystem();
    const handle = new AgentScopes({ ...fake.system, runAsync: async () => ({ code: 1, stdout: "", stderr: "" }) }).wrap({ command: "codex", args: [], name: "codex" }).scope!;
    expect(await handle.oomKilled()).toBe(false);
  });

  it("gives up on a scope that never finishes stopping", async () => {
    const { handle } = launch([show({ ActiveState: "deactivating" })]);
    expect(await handle.oomKilled()).toBe(false);
  });
});

describe("Pi's bash shell", () => {
  let directory: string | undefined;
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = undefined; });

  it("starts the real shell in its own scope and keeps the arguments", () => {
    const script = agentShellScript("/bin/bash", { ...setup, runtimeDir: "/run/user/1000" });
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("echo 800 >/proc/self/oom_score_adj");
    expect(script).toContain(`exec '/usr/bin/systemd-run' --user --scope --quiet --collect --slice=${AGENT_SLICE} --property=OOMPolicy=stop '--description=Tau agent shell' -- '/bin/bash' "$@"`);
  });

  it("writes an executable script under a private directory and reuses it", () => {
    directory = mkdtempSync(join(tmpdir(), "agent-shell-"));
    const scopes = new AgentScopes(fakeSystem().system);
    const path = scopes.agentShell("/bin/bash", directory);
    expect(path).toBeDefined();
    expect(readFileSync(path!, "utf8")).toBe(agentShellScript("/bin/bash", setup));
    expect(statSync(path!).mode & 0o777).toBe(0o700);
    expect(scopes.agentShell("/bin/bash", directory)).toBe(path);
  });

  it("has no shell where scopes are off", () => {
    expect(new AgentScopes(fakeSystem({ platform: "darwin" }).system).agentShell("/bin/bash", "/nonexistent")).toBeUndefined();
    expect(new AgentScopes(fakeSystem({ env: { PATH: "/usr/bin" } }).system).agentShell("/bin/bash", "/nonexistent")).toBeUndefined();
  });
});
