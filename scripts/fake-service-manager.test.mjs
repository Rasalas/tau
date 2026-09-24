import { describe, expect, it } from "vitest";
import { renderLaunchAgent, renderSystemdUnit } from "../src/main/host-service-units.ts";
import { parseLaunchAgent, parseSystemdUnit } from "./fake-service-manager.mjs";

// The fake starts exactly what a unit says, or a smoke that passes against it proves nothing.
describe("the fake service manager reads the units Tau writes", () => {
  const spec = {
    program: ["/opt/Tau App/tau", "/opt/Tau App/resources/100%/$HOME \"quoted\"\\headless.js"],
    env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1", TAU_USER_DATA: "/home/me/.config/100% \"tau\" & <co>" },
    workingDirectory: "/home/me",
    logPath: "/home/me/logs/100%.log",
  };

  it("a LaunchAgent", () => {
    expect(parseLaunchAgent(renderLaunchAgent("dev.tbuck.tau.host.x", spec))).toEqual({
      label: "dev.tbuck.tau.host.x", program: spec.program, env: spec.env, cwd: spec.workingDirectory, log: spec.logPath,
    });
  });

  it("a systemd unit", () => {
    expect(parseSystemdUnit(renderSystemdUnit(spec), "/home/me")).toEqual({ program: spec.program, env: spec.env, cwd: "/home/me", log: spec.logPath });
  });
});
