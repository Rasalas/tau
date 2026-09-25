import { describe, expect, it, vi } from "vitest";
import type { UiHostService } from "../shared/connections.js";
import { describeService, runServiceCommand } from "./service-cli.js";

function status(overrides: Partial<UiHostService> = {}): UiHostService {
  return {
    supported: true, manager: "launchd", label: "dev.tbuck.tau.host", installed: true, running: true, serving: false, stale: false,
    version: "0.4.0", unitPath: "/Users/me/Library/LaunchAgents/dev.tbuck.tau.host.plist", logPath: "/u/logs/host-service.log", problems: [],
    ...overrides,
  };
}

function fakeManager(current: UiHostService) {
  return {
    status: vi.fn(async () => current),
    install: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => true),
    restart: vi.fn(async () => undefined),
  };
}

describe("tau service", () => {
  it("installs and prints where the service stands", async () => {
    const manager = fakeManager(status());
    const out: string[] = [];
    expect(await runServiceCommand("install", { out: (line) => out.push(line), manager })).toBe(0);
    expect(manager.install).toHaveBeenCalledOnce();
    expect(out).toEqual([
      "Installed. The service starts Tau's host now and at every login; a running Tau window moves over to it.",
      "Tau host service (launchd, dev.tbuck.tau.host)",
      "  installed: yes",
      "  running:   yes, Tau 0.4.0",
      "  unit:      /Users/me/Library/LaunchAgents/dev.tbuck.tau.host.plist",
      "  log:       /u/logs/host-service.log",
    ]);
  });

  it("uninstalls, restarts, and refuses an action it does not know", async () => {
    const manager = fakeManager(status());
    const out: string[] = [];
    expect(await runServiceCommand("uninstall", { out: (line) => out.push(line), manager })).toBe(0);
    expect(out).toEqual(["Uninstalled. The next Tau window starts a host of its own."]);
    manager.uninstall.mockResolvedValueOnce(false);
    await runServiceCommand("uninstall", { out: (line) => out.push(line), manager });
    expect(out.at(-1)).toBe("No service was installed.");
    await runServiceCommand("restart", { out: (line) => out.push(line), manager });
    expect(manager.restart).toHaveBeenCalledOnce();
    expect(await runServiceCommand("reload", { out: (line) => out.push(line), manager })).toBe(1);
    expect(await runServiceCommand(undefined, { out: (line) => out.push(line), manager })).toBe(0);
  });

  it("adds or removes the invisible display, and refuses a flag anywhere else", async () => {
    const manager = fakeManager(status({
      manager: "systemd", label: "tau-host.service",
      display: { supported: true, installed: true, display: ":99", xvfbRunning: true, windowRunning: false, idleMinutes: 10 },
    }));
    const out: string[] = [];
    expect(await runServiceCommand("install", { out: (line) => out.push(line), manager }, ["--display"])).toBe(0);
    expect(manager.install).toHaveBeenLastCalledWith({ display: true });
    expect(out).toContain("  display:   :99 (Xvfb running; window stopped, starts when a thread needs it and stops after 10 min idle)");
    await runServiceCommand("install", { out: (line) => out.push(line), manager }, ["--no-display"]);
    expect(manager.install).toHaveBeenLastCalledWith({ display: false });
    await runServiceCommand("install", { out: (line) => out.push(line), manager });
    expect(manager.install).toHaveBeenLastCalledWith({});
    expect(await runServiceCommand("status", { out: (line) => out.push(line), manager }, ["--display"])).toBe(1);
    expect(await runServiceCommand("install", { out: (line) => out.push(line), manager }, ["--screen"])).toBe(1);
  });

  it("says what is wrong and the command that fixes it, or why the machine cannot run it", () => {
    const lines = describeService(status({
      manager: "systemd",
      label: "tau-host.service",
      running: false,
      stale: true,
      problems: [{ code: "linger-disabled", message: "Lingering is off.", command: "sudo loginctl enable-linger \"$(id -un)\"" }],
    }));
    expect(lines).toContain("  installed: yes, but for another copy or other settings of Tau (run tau service install)");
    expect(lines).toContain("  running:   no");
    expect(lines.slice(-2)).toEqual(["  ! Lingering is off.", "    sudo loginctl enable-linger \"$(id -un)\""]);
    expect(describeService(status({ supported: false, reason: "An AppImage cannot." }))).toEqual(["Tau's host cannot run as a service here: An AppImage cannot."]);
  });
});
