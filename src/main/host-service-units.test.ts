import { describe, expect, it } from "vitest";
import {
  HOST_SERVICE_ENV,
  defaultUserData,
  hostServiceNames,
  renderLaunchAgent,
  renderSystemdUnit,
  renderWindowsLauncher,
  renderWindowsTask,
  serviceEnvironment,
  servicePath,
  utf16WithBom,
  type HostServiceSpec,
} from "./host-service-units.js";

const spec: HostServiceSpec = {
  program: ["/Applications/Tau.app/Contents/MacOS/Tau", "/Applications/Tau.app/Contents/Resources/app.asar.unpacked/dist-electron/main/headless.js"],
  env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1", TAU_USER_DATA: "/Users/me/Library/Application Support/tau & co <1>" },
  workingDirectory: "/Users/me",
  logPath: "/Users/me/Library/Application Support/tau/logs/host-service.log",
};

describe("service names", () => {
  it("keeps the plain names for the default userData and gives any other its own", () => {
    const home = "/Users/me";
    const plain = hostServiceNames(defaultUserData("darwin", home, {}), defaultUserData("darwin", home, {}));
    expect(plain).toEqual({ label: "dev.tbuck.tau.host", unit: "tau-host.service", task: "Tau Host" });
    const other = hostServiceNames("/w/.tau-dev/userdata", defaultUserData("darwin", home, {}));
    expect(other.label).toMatch(/^dev\.tbuck\.tau\.host\.[0-9a-f]{8}$/u);
    expect(other.unit).toMatch(/^tau-host-[0-9a-f]{8}\.service$/u);
    expect(hostServiceNames("/w/.tau-dev/userdata", "/x")).toEqual(other);
  });

  it("finds the app's default userData on each platform", () => {
    expect(defaultUserData("darwin", "/Users/me", {})).toBe("/Users/me/Library/Application Support/tau-pi-desktop-prototype");
    expect(defaultUserData("linux", "/home/me", { XDG_CONFIG_HOME: "/cfg" })).toBe("/cfg/tau-pi-desktop-prototype");
    expect(defaultUserData("win32", "C:\\Users\\me", { APPDATA: "D:\\Roaming" })).toBe("D:\\Roaming\\tau-pi-desktop-prototype");
  });
});

describe("the service environment", () => {
  it("is the supervised host's, with the instance's own folders and without a version or workspace", () => {
    const env = serviceEnvironment({
      userData: "/u",
      manager: "systemd",
      path: "/usr/bin",
      env: { TAU_CONFIG_FILE: "/w/.tau-dev/config.json", TAU_HOST_VERSION: "1.0.0", TAU_WORKSPACE: "/repo", SECRET_TOKEN: "x", PI_CODING_AGENT_DIR: "" },
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      ELECTRON_RUN_AS_NODE: "1",
      TAU_USER_DATA: "/u",
      TAU_HOST_LISTEN: "127.0.0.1:0",
      TAU_HOST_LOCAL_FILES: "1",
      [HOST_SERVICE_ENV]: "systemd",
      TAU_CONFIG_FILE: "/w/.tau-dev/config.json",
    });
  });

  it("reads the same PATH whoever installs it", () => {
    expect(servicePath("darwin", "/Applications/Tau.app/Contents/MacOS/Tau")).toBe("/Applications/Tau.app/Contents/MacOS:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(servicePath("linux", "/usr/bin/node")).toBe("/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin");
    expect(servicePath("win32", "C:\\Tau\\Tau.exe")).toBe("");
  });
});

describe("a LaunchAgent", () => {
  it("escapes what it names and restarts only a host that failed", () => {
    const plist = renderLaunchAgent("dev.tbuck.tau.host", spec);
    expect(plist).toContain("<string>/Users/me/Library/Application Support/tau &amp; co &lt;1&gt;</string>");
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/u);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
  });
});

describe("a systemd user unit", () => {
  it("quotes arguments, escapes specifiers and restarts only a host that failed", () => {
    const tricky: HostServiceSpec = {
      ...spec,
      program: ["/opt/Tau App/tau", "/opt/Tau App/resources/100%/$HOME \"quoted\"\\headless.js"],
      env: { TAU_USER_DATA: "/home/me/.config/100% \"tau\"" },
      logPath: "/home/me/logs/100%.log",
    };
    const unit = renderSystemdUnit(tricky);
    expect(unit).toContain('ExecStart="/opt/Tau App/tau" "/opt/Tau App/resources/100%%/$$HOME \\"quoted\\"\\\\headless.js"');
    expect(unit).toContain('Environment="TAU_USER_DATA=/home/me/.config/100%% \\"tau\\""');
    expect(unit).toContain("StandardOutput=append:/home/me/logs/100%%.log");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("a Windows task", () => {
  const windows: HostServiceSpec = {
    program: ["C:\\Program Files\\Tau\\Tau.exe", "C:\\Program Files\\Tau\\resources\\app.asar.unpacked\\dist-electron\\main\\headless.js"],
    env: { PATH: "", ELECTRON_RUN_AS_NODE: "1", TAU_USER_DATA: "C:\\Users\\John \"JD\" Doe\\AppData\\Roaming\\tau" },
    workingDirectory: "C:\\Users\\John Doe",
    logPath: "C:\\Users\\John Doe\\AppData\\Roaming\\tau\\logs\\host-service.log",
  };

  it("sets the environment in a launcher script and starts the host without a window", () => {
    const launcher = renderWindowsLauncher(windows);
    expect(launcher).toContain('env("TAU_USER_DATA") = "C:\\Users\\John ""JD"" Doe\\AppData\\Roaming\\tau"');
    expect(launcher).not.toContain('env("PATH")');
    expect(launcher).toContain('WScript.Quit shell.Run("cmd.exe /d /s /c """"C:\\Program Files\\Tau\\Tau.exe"" ""C:\\Program Files\\Tau\\resources\\app.asar.unpacked\\dist-electron\\main\\headless.js"" >> ""C:\\Users\\John Doe\\AppData\\Roaming\\tau\\logs\\host-service.log"" 2>&1""", 0, True)');
    expect(launcher.split("\r\n").length).toBeGreaterThan(4);
  });

  it("runs the launcher at logon of this user and restarts it after a failure", () => {
    const task = renderWindowsTask({ user: "HOST\\John", launcherPath: "C:\\Users\\John Doe\\tau-host.vbs" });
    expect(task).toContain("<UserId>HOST\\John</UserId>");
    expect(task).toContain("<Arguments>//B //NoLogo &quot;C:\\Users\\John Doe\\tau-host.vbs&quot;</Arguments>");
    expect(task).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(task).toContain("<RestartOnFailure>");
    const bytes = utf16WithBom(task);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
    expect(bytes.subarray(2).toString("utf16le")).toBe(task);
  });
});
