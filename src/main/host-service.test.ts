import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_CORE_PRINCIPAL } from "./host-invocation.js";
import type { HostMethodContext } from "./host-jobs.js";
import { writeHostDescriptor } from "./host-process-supervisor.js";
import { HostServiceManager, createHostServiceMethods, serviceCommandRunner, type ServiceCommandResult, type ServiceStep } from "./host-service.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temp(): string {
  const directory = mkdtempSync(join(tmpdir(), "tau-service-"));
  directories.push(directory);
  return directory;
}

const line = (step: ServiceStep) => [step.command, ...step.args].join(" ");

/** Records every command; `answer` stands in for what the service manager would print. */
function fakeRunner(answer: (command: string) => Partial<ServiceCommandResult> | undefined = () => undefined) {
  const calls: string[] = [];
  const detached: string[][] = [];
  return {
    calls,
    detached,
    runner: {
      run: async (step: ServiceStep): Promise<ServiceCommandResult> => {
        calls.push(line(step));
        return { code: 0, stdout: "", stderr: "", ...answer(line(step)) };
      },
      detach: (steps: readonly ServiceStep[]) => { detached.push(steps.map(line)); },
    },
  };
}

function manager(platform: NodeJS.Platform, options: { answer?: (command: string) => Partial<ServiceCommandResult> | undefined; execPath?: string; env?: NodeJS.ProcessEnv; retireHost?: () => Promise<void> } = {}) {
  const root = temp();
  const userData = join(root, "userdata");
  const units = join(root, "units");
  const fake = fakeRunner(options.answer);
  const service = new HostServiceManager({
    execPath: options.execPath ?? "/Applications/Tau.app/Contents/MacOS/Tau",
    entry: "/Applications/Tau.app/Contents/Resources/app.asar.unpacked/dist-electron/main/headless.js",
    userData,
    platform,
    home: join(root, "home"),
    uid: 501,
    windowsUser: "HOST\\me",
    env: { TAU_SERVICE_UNIT_DIR: units, ...options.env },
    runner: fake.runner,
    ...(options.retireHost ? { retireHost: options.retireHost } : {}),
  });
  return { service, userData, units, ...fake };
}

const owner: HostMethodContext = { principal: HOST_CORE_PRINCIPAL } as HostMethodContext;

describe("the host service on macOS", () => {
  it("writes a LaunchAgent and loads it", async () => {
    const { service, units, userData, calls } = manager("darwin");
    expect((await service.status()).installed).toBe(false);

    await service.install();

    const plist = join(units, `${service.names.label}.plist`);
    expect(readFileSync(plist, "utf8")).toContain(`<string>${userData}</string>`);
    expect(existsSync(join(userData, "logs"))).toBe(true);
    const target = `gui/501/${service.names.label}`;
    expect(calls).toEqual([`launchctl bootout --wait ${target}`, `launchctl enable ${target}`, `launchctl bootstrap gui/501 ${plist}`]);
  });

  it("reports the service host that runs, and whether the asking host is it", async () => {
    const { service, userData } = manager("darwin");
    await service.install();
    await writeHostDescriptor(userData, { pid: process.pid, url: "ws://127.0.0.1:1", tokenPath: "", startedAt: "", version: "9.9.9", service: "launchd" });

    expect(await service.status({ pid: process.pid })).toMatchObject({
      supported: true, manager: "launchd", installed: true, running: true, serving: true, stale: false, version: "9.9.9", problems: [],
    });
    expect((await service.status({ pid: 1 })).serving).toBe(false);
  });

  it("does not count a window's own host as the service", async () => {
    const { service, userData } = manager("darwin");
    await service.install();
    await writeHostDescriptor(userData, { pid: process.pid, url: "ws://127.0.0.1:1", tokenPath: "", startedAt: "", version: "1" });
    expect(await service.status({ pid: process.pid })).toMatchObject({ running: false, serving: false });
  });

  it("calls a unit for another copy of Tau stale, and a unit launchd did not load a problem", async () => {
    const first = manager("darwin");
    await first.service.install();
    const other = new HostServiceManager({
      execPath: "/Users/me/Downloads/Tau.app/Contents/MacOS/Tau",
      entry: "/x/headless.js",
      userData: first.userData,
      platform: "darwin",
      uid: 501,
      env: { TAU_SERVICE_UNIT_DIR: first.units },
      runner: fakeRunner((command) => (command.startsWith("launchctl print") ? { code: 113 } : undefined)).runner,
    });
    const status = await other.status();
    expect(status.stale).toBe(true);
    expect(status.problems.map((problem) => problem.code)).toEqual(["not-loaded"]);
  });

  it("removes the LaunchAgent and boots it out", async () => {
    const { service, units, calls } = manager("darwin");
    expect(await service.uninstall()).toBe(false);
    await service.install();
    calls.length = 0;

    expect(await service.uninstall()).toBe(true);

    expect(existsSync(join(units, `${service.names.label}.plist`))).toBe(false);
    expect(calls).toEqual([`launchctl bootout --wait gui/501/${service.names.label}`]);
  });

  it("starts, then kickstarts, and restarts with -k", async () => {
    const { service, calls } = manager("darwin");
    await service.install();
    calls.length = 0;
    await service.start();
    await service.restart();
    const target = `gui/501/${service.names.label}`;
    expect(calls.slice(1)).toEqual([`launchctl kickstart ${target}`, `launchctl kickstart -k ${target}`]);
  });

  it("hands the steps that stop the asking host to a process of their own", async () => {
    const { service, calls, detached } = manager("darwin");
    await service.install({ detached: true });
    expect(calls).toEqual([]);
    expect(detached).toHaveLength(1);
    expect(detached[0]!.at(-1)).toMatch(/^launchctl bootstrap gui\/501 /u);
  });

  it("names the command that failed and what it said", async () => {
    const { service } = manager("darwin", { answer: (command) => (command.startsWith("launchctl bootstrap") ? { code: 5, stderr: "Bootstrap failed: 5: Input/output error\nmore" } : { code: 3 }) });
    await expect(service.install()).rejects.toThrow(/`launchctl bootstrap gui\/501 .*` failed \(exit 5\): Bootstrap failed: 5: Input\/output error\.$/u);
  });

  it("refuses a copy of Tau that macOS runs from a temporary folder", async () => {
    const { service } = manager("darwin", { execPath: "/private/var/folders/x/AppTranslocation/ABC/d/Tau.app/Contents/MacOS/Tau" });
    const status = await service.status();
    expect(status).toMatchObject({ supported: false, installed: false });
    expect(status.reason).toMatch(/Move Tau to Applications/u);
    await expect(service.install()).rejects.toThrow(/Move Tau to Applications/u);
  });

  it("puts the unit in LaunchAgents without an override", async () => {
    const service = new HostServiceManager({ execPath: "/t", entry: "/e", userData: "/u", platform: "darwin", home: "/Users/me", uid: 501, env: {}, runner: fakeRunner().runner });
    expect((await service.status()).unitPath).toBe(`/Users/me/Library/LaunchAgents/${service.names.label}.plist`);
  });
});

describe("the host service on Linux", () => {
  it("writes a user unit, enables lingering, and starts it", async () => {
    const { service, units, calls } = manager("linux", { answer: (command) => (command.startsWith("loginctl show-user") ? { stdout: "no\n" } : undefined) });
    await service.install();

    const unit = service.names.unit;
    expect(readFileSync(join(units, unit), "utf8")).toContain("Environment=\"TAU_HOST_SERVICE=systemd\"");
    expect(calls).toEqual([
      "systemctl --user show-environment",
      "loginctl show-user 501 --property=Linger --value",
      "loginctl enable-linger --no-ask-password 501",
      "systemctl --user daemon-reload",
      `systemctl --user enable ${unit}`,
      `systemctl --user restart ${unit}`,
    ]);
  });

  it("refuses to install without a user manager, and writes nothing", async () => {
    const { service, units } = manager("linux", { answer: (command) => (command === "systemctl --user show-environment" ? { code: 1 } : undefined) });
    await expect(service.install()).rejects.toThrow(/systemd user manager does not answer/u);
    expect(existsSync(join(units, service.names.unit))).toBe(false);
  });

  it("says when the unit is not enabled and lingering is off", async () => {
    const { service } = manager("linux", {
      answer: (command) => (command.startsWith("systemctl --user is-enabled") ? { code: 1, stdout: "disabled\n" } : command.startsWith("loginctl show-user") ? { stdout: "no\n" } : undefined),
    });
    await service.install();
    const problems = (await service.status()).problems;
    expect(problems.map((problem) => problem.code)).toEqual(["service-disabled", "linger-disabled"]);
    expect(problems[1]!.command).toBe("sudo loginctl enable-linger \"$(id -un)\"");
  });

  it("disables and removes the unit before it stops the host", async () => {
    const { service, calls } = manager("linux");
    await service.install();
    calls.length = 0;
    await service.uninstall({ detached: false });
    const unit = service.names.unit;
    expect(calls).toEqual([`systemctl --user disable ${unit}`, "systemctl --user daemon-reload", `systemctl --user stop ${unit}`]);
  });

  it("puts the unit under XDG_CONFIG_HOME without an override, and refuses an AppImage", async () => {
    const plain = new HostServiceManager({ execPath: "/usr/lib/tau/tau", entry: "/e", userData: "/u", platform: "linux", home: "/home/me", uid: 1000, env: { XDG_CONFIG_HOME: "/cfg" }, runner: fakeRunner().runner });
    expect((await plain.status()).unitPath).toBe(`/cfg/systemd/user/${plain.names.unit}`);
    const appImage = new HostServiceManager({ execPath: "/tmp/.mount_TauXYZ/tau", entry: "/e", userData: "/u", platform: "linux", home: "/home/me", uid: 1000, env: {}, runner: fakeRunner().runner });
    expect((await appImage.status()).reason).toMatch(/AppImage/u);
  });
});

describe("the host service on Windows", () => {
  it("registers a task that runs a launcher script, and runs it", async () => {
    const { service, units, calls } = manager("win32", { execPath: "C:\\Program Files\\Tau\\Tau.exe" });
    await service.install();

    const base = service.names.task.replaceAll(" ", "-").toLowerCase();
    const xml = readFileSync(join(units, `${base}.xml`));
    expect([...xml.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(xml.subarray(2).toString("utf16le")).toContain("<UserId>HOST\\me</UserId>");
    expect(readFileSync(join(units, `${base}.vbs`), "utf8")).toContain('env("TAU_HOST_SERVICE") = "task-scheduler"');
    expect(calls).toEqual([
      `schtasks /Create /TN ${service.names.task} /XML ${join(units, `${base}.xml`)} /F`,
      `schtasks /End /TN ${service.names.task}`,
      `schtasks /Run /TN ${service.names.task}`,
    ]);
  });

  it("deletes the task and stops the host it left running", async () => {
    const retireHost = vi.fn(async () => undefined);
    const { service, calls } = manager("win32", { execPath: "C:\\Tau\\Tau.exe", retireHost });
    await service.install();
    calls.length = 0;
    await service.uninstall();
    expect(calls).toEqual([`schtasks /End /TN ${service.names.task}`, `schtasks /Delete /TN ${service.names.task} /F`]);
    expect(retireHost).toHaveBeenCalledOnce();
  });

  it("says when Task Scheduler lost the task", async () => {
    const { service } = manager("win32", { execPath: "C:\\Tau\\Tau.exe", answer: (command) => (command.startsWith("schtasks /Query") ? { code: 1 } : undefined) });
    await service.install();
    expect((await service.status()).problems.map((problem) => problem.code)).toEqual(["not-registered"]);
  });
});

describe("a platform without a known service manager", () => {
  it("says so instead of installing anything", async () => {
    const { service } = manager("freebsd");
    expect(await service.status()).toMatchObject({ supported: false, installed: false, running: false });
    await expect(service.install()).rejects.toThrow(/no service manager on freebsd/u);
  });
});

describe("the Connections methods", () => {
  it("show the status to any client and leave installing and removing to the owner", async () => {
    const { service } = manager("darwin");
    const methods = createHostServiceMethods(() => service);
    const paired = { principal: { kind: "workbench-client", pairedClient: "phone" } } as HostMethodContext;
    expect(await methods["service-status"]!([], paired)).toMatchObject({ installed: false });
    await expect(methods["service-install"]!([], paired)).rejects.toMatchObject({ code: "forbidden" });
    await expect(methods["service-uninstall"]!([], paired)).rejects.toMatchObject({ code: "forbidden" });
    expect(await methods["service-status"]!([], owner)).toMatchObject({ installed: false });
  });

  it("run the steps in this process for a window's host, and detached for the service host itself", async () => {
    const { service, userData, calls, detached } = manager("darwin");
    const methods = createHostServiceMethods(() => service, { pid: process.pid });
    await methods["service-install"]!([], owner);
    expect(calls.some((command) => command.startsWith("launchctl bootstrap"))).toBe(true);
    expect(detached).toEqual([]);

    await writeHostDescriptor(userData, { pid: process.pid, url: "ws://127.0.0.1:1", tokenPath: "", startedAt: "", version: "1", service: "launchd" });
    const status = await methods["service-uninstall"]!([], owner) as { installed: boolean };
    expect(status.installed).toBe(false);
    expect(detached).toEqual([[`launchctl bootout --wait gui/501/${service.names.label}`]]);
  });

  it("say when the host has no service manager to ask", async () => {
    const methods = createHostServiceMethods(() => undefined);
    await expect(methods["service-status"]!([], owner)).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("the command runner", () => {
  it("sends every command through TAU_SERVICE_CONTROL when it names a stand-in", async () => {
    const directory = temp();
    const control = join(directory, "control.mjs");
    writeFileSync(control, "console.log(JSON.stringify(process.argv.slice(2))); process.exit(process.argv[2] === 'fail' ? 3 : 0);\n");
    chmodSync(control, 0o755);
    const runner = serviceCommandRunner({ ...process.env, TAU_SERVICE_CONTROL: control }, process.execPath);

    const result = await runner.run({ command: "launchctl", args: ["print", "gui/501/x y"] });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["launchctl", "print", "gui/501/x y"]);
    expect((await runner.run({ command: "fail", args: [] })).code).toBe(3);
  });

  it("reports a command that is not there instead of throwing", async () => {
    const runner = serviceCommandRunner({ PATH: "" }, process.execPath, "linux");
    const result = await runner.run({ command: "tau-no-such-service-manager", args: [] });
    expect(result.code).not.toBe(0);
  });
});
