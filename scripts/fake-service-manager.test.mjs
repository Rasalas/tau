import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderLaunchAgent, renderSystemdUnit, renderWindowUnit, renderXvfbUnit } from "../src/main/host-service-units.ts";
import { main, parseLaunchAgent, parseSystemdUnit, systemdDependencies } from "./fake-service-manager.mjs";

// The fake starts exactly what a unit says, or a smoke that passes against it proves nothing.
describe("the fake service manager reads the units Tau writes", () => {
  const spec = {
    program: ["/opt/Tau App/tau", "/opt/Tau App/resources/100%/$HOME \"quoted\"\\headless.js"],
    env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1", TAU_USER_DATA: "/home/me/.config/100% \"tau\" & <co>" },
    workingDirectory: "/home/me",
    logPath: "/home/me/logs/100%.log",
  };
  const display = {
    number: 99, xvfb: "/usr/bin/Xvfb", authPath: "/home/me/100%/Xauthority", xvfbUnit: "tau-xvfb.service", windowUnit: "tau-window.service",
    window: { program: ["/opt/Tau App/tau"], env: { DISPLAY: ":99", TAU_NO_FOCUS: "1" }, workingDirectory: "/home/me", logPath: "/home/me/logs/window.log" },
  };

  it("a LaunchAgent", () => {
    expect(parseLaunchAgent(renderLaunchAgent("dev.tbuck.tau.host.x", spec))).toEqual({
      label: "dev.tbuck.tau.host.x", program: spec.program, env: spec.env, cwd: spec.workingDirectory, log: spec.logPath,
    });
  });

  it("a systemd unit", () => {
    expect(parseSystemdUnit(renderSystemdUnit(spec), "/home/me")).toEqual({ program: spec.program, env: spec.env, cwd: "/home/me", log: spec.logPath });
  });

  it("the display's units and what each pulls in", () => {
    expect(parseSystemdUnit(renderXvfbUnit(display, "/home/me/logs/xvfb.log"), "/home/me").program)
      .toEqual(["/usr/bin/Xvfb", ":99", "-nolisten", "tcp", "-screen", "0", "1920x1080x24", "-auth", "/home/me/100%/Xauthority"]);
    expect(parseSystemdUnit(renderXvfbUnit(display, "/home/me/logs/xvfb.log"), "/home/me").before)
      .toEqual([{ program: ["/bin/mkdir", "-p", "-m", "1777", "/tmp/.X11-unix"], optional: true }]);
    const window = renderWindowUnit(display, "tau-host.service");
    expect(parseSystemdUnit(window, "/home/me")).toEqual({ program: display.window.program, env: display.window.env, cwd: "/home/me", log: display.window.logPath });
    expect(systemdDependencies(window)).toEqual({ pulls: ["tau-xvfb.service", "tau-host.service"], bindsTo: ["tau-xvfb.service", "tau-host.service"] });
    expect(systemdDependencies(renderSystemdUnit(spec, display))).toEqual({ pulls: ["tau-xvfb.service"], bindsTo: [] });
  });
});

describe("the fake systemctl", () => {
  const directories = [];
  afterEach(async () => {
    for (const directory of directories.splice(0)) {
      const state = JSON.parse(readFileSync(join(directory, ".fake-state.json"), "utf8"));
      for (const entry of Object.values(state)) if (entry.pid) { try { process.kill(entry.pid, "SIGKILL"); } catch { /* gone */ } }
      rmSync(directory, { recursive: true, force: true });
    }
    delete process.env.TAU_SERVICE_UNIT_DIR;
  });

  it("starts what a unit pulls in, and stops a unit bound to one that stops", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-fake-systemctl-"));
    directories.push(directory);
    process.env.TAU_SERVICE_UNIT_DIR = directory;
    const sleeper = (name, extra = "") => [
      "[Unit]", extra, "[Service]", `ExecStart="${process.execPath}" "-e" "setTimeout(() => {}, 60000)"`, `StandardOutput=append:${join(directory, `${name}.log`)}`, "",
    ].join("\n");
    writeFileSync(join(directory, "xvfb.service"), sleeper("xvfb"));
    writeFileSync(join(directory, "host.service"), sleeper("host", "Wants=xvfb.service"));
    writeFileSync(join(directory, "window.service"), sleeper("window", "BindsTo=xvfb.service host.service"));
    const state = () => JSON.parse(readFileSync(join(directory, ".fake-state.json"), "utf8"));
    const running = (name) => { const pid = state()[name]?.pid; try { return Boolean(pid) && (process.kill(pid, 0), true); } catch { return false; } };

    expect(await main(["systemctl", "--user", "start", "host.service"])).toBe(0);
    expect([running("host.service"), running("xvfb.service"), running("window.service")]).toEqual([true, true, false]);
    expect(await main(["systemctl", "--user", "start", "window.service"])).toBe(0);
    expect(await main(["systemctl", "--user", "is-active", "window.service"])).toBe(0);

    expect(await main(["systemctl", "--user", "stop", "host.service"])).toBe(0);
    expect([running("host.service"), running("xvfb.service"), running("window.service")]).toEqual([false, true, false]);
  });
});
