import { describe, expect, it } from "vitest";
import { installShellEnvironment } from "./shell-environment.js";
import { APP_IDENTITIES } from "./app-identity.js";
import {
  HOST_SERVICE_ENV,
  defaultUserData,
  leaveDesktopSession,
  displayServiceNames,
  hostServiceNames,
  renderWindowUnit,
  renderXauthority,
  renderXvfbUnit,
  windowEnvironment,
  windowProgram,
  type HostDisplaySpec,
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

  it("names Tau Dev's service apart from the released app's", () => {
    const dev = APP_IDENTITIES.dev;
    const userData = defaultUserData("darwin", "/Users/me", {}, dev);
    expect(userData).toBe("/Users/me/Library/Application Support/tau-dev");
    expect(hostServiceNames(userData, userData, dev)).toEqual({ label: "de.tbuck.tau.dev.host", unit: "tau-dev-host.service", task: "Tau Dev Host" });
    expect(displayServiceNames("tau-dev-host-1a2b.service", dev)).toEqual({ xvfbUnit: "tau-dev-xvfb-1a2b.service", windowUnit: "tau-dev-window-1a2b.service" });
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

  it("belongs to the app's bundle id under the label it had before that id changed", () => {
    const plist = renderLaunchAgent(hostServiceNames("/u", "/u").label, spec);
    expect(plist).toContain("<key>Label</key>\n  <string>dev.tbuck.tau.host</string>");
    expect(plist).toContain("<key>AssociatedBundleIdentifiers</key>\n  <string>de.tbuck.tau</string>");
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

describe("the invisible display", () => {
  const display: HostDisplaySpec = {
    number: 101,
    xvfb: "/usr/bin/Xvfb",
    authPath: "/home/me/.config/tau/display/Xauthority",
    xvfbUnit: "tau-xvfb.service",
    windowUnit: "tau-window.service",
    window: {
      program: ["/opt/Tau/tau"],
      env: { DISPLAY: ":101", TAU_NO_FOCUS: "1" },
      workingDirectory: "/home/me",
      logPath: "/home/me/.config/tau/logs/display-window.log",
    },
  };

  it("names its units after the host's, suffix and all", () => {
    expect(displayServiceNames("tau-host.service")).toEqual({ xvfbUnit: "tau-xvfb.service", windowUnit: "tau-window.service" });
    expect(displayServiceNames("tau-host-1a2b3c4d.service")).toEqual({ xvfbUnit: "tau-xvfb-1a2b3c4d.service", windowUnit: "tau-window-1a2b3c4d.service" });
  });

  it("runs Xvfb without TCP and with a cookie, started by the host unit", () => {
    const xvfb = renderXvfbUnit(display, "/home/me/logs/xvfb.log");
    expect(xvfb).toContain('ExecStart="/usr/bin/Xvfb" ":101" "-nolisten" "tcp" "-screen" "0" "1920x1080x24" "-auth" "/home/me/.config/tau/display/Xauthority"');
    expect(xvfb).not.toContain("[Install]");
    expect(xvfb).toContain("ExecStartPre=-/bin/mkdir -p -m 1777 /tmp/.X11-unix\nExecStart=");
    const host = renderSystemdUnit(spec, display);
    expect(host).toContain("Wants=tau-xvfb.service\nAfter=tau-xvfb.service");
    expect(renderSystemdUnit(spec)).not.toContain("Wants=");
  });

  // A desktop session's user manager hands every unit WAYLAND_DISPLAY; Electron then picks the real screen.
  it("keeps the desktop's Wayland from the host and the window, and only when there is a display", () => {
    const unset = "UnsetEnvironment=WAYLAND_DISPLAY WAYLAND_SOCKET XDG_SESSION_TYPE";
    expect(renderSystemdUnit(spec, display)).toContain(`${unset}\nExecStart=`);
    expect(renderWindowUnit(display, "tau-host.service")).toContain(`${unset}\nExecStart=`);
    expect(renderSystemdUnit(spec)).not.toContain("UnsetEnvironment");
  });

  // Needs a real /bin/sh to count as a login shell.
  it.runIf(process.platform !== "win32")("drops the desktop's Wayland from the host's environment, and a login shell does not bring it back", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/sh", DISPLAY: ":99", WAYLAND_DISPLAY: "wayland-0", WAYLAND_SOCKET: "3", XDG_SESSION_TYPE: "wayland" };
    expect(leaveDesktopSession(env)).toEqual(["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_SESSION_TYPE"]);
    const marker = (name: string, value: string) => `__TAU_ENV_${name}_START__\n${value}\n__TAU_ENV_${name}_END__`;
    await installShellEnvironment({
      env,
      platform: "linux",
      run: async () => [marker("PATH", "/usr/local/bin"), marker("WAYLAND_DISPLAY", "wayland-1"), marker("XDG_SESSION_TYPE", "wayland")].join("\n"),
    });
    expect(env).toEqual({ PATH: "/usr/local/bin:/usr/bin", SHELL: "/bin/sh", DISPLAY: ":99" });
    expect(leaveDesktopSession(env)).toEqual([]);
  });

  it("binds the window to Xvfb and the host, and only the host starts it", () => {
    const window = renderWindowUnit(display, "tau-host.service");
    expect(window).toContain("BindsTo=tau-xvfb.service tau-host.service");
    expect(window).toContain("After=tau-xvfb.service tau-host.service");
    expect(window).toContain('Environment="DISPLAY=:101"');
    expect(window).toContain('Environment="TAU_NO_FOCUS=1"');
    expect(window).toContain('ExecStart="/opt/Tau/tau"');
    expect(window).not.toContain("[Install]");
  });

  it("gives the window the host's instance, never the host's own switches", () => {
    const env = windowEnvironment({
      PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", TAU_USER_DATA: "/u", TAU_HOST_LISTEN: "127.0.0.1:0", TAU_HOST_LOCAL_FILES: "1",
      [HOST_SERVICE_ENV]: "systemd", TAU_CONFIG_FILE: "/c.json", TAU_HOST_ALLOWED_ORIGINS: "http://x",
    }, { number: 99, authPath: "/u/display/Xauthority" });
    expect(env).toEqual({
      PATH: "/usr/bin", TAU_USER_DATA: "/u", TAU_CONFIG_FILE: "/c.json", TAU_HOST_ALLOWED_ORIGINS: "http://x",
      DISPLAY: ":99", XAUTHORITY: "/u/display/Xauthority", TAU_NO_FOCUS: "1", TAU_NO_NATIVE_DIALOGS: "1",
    });
  });

  it("starts the app itself on X11: a package's binary, or Electron with the checkout", () => {
    expect(windowProgram("/opt/Tau/tau", "/opt/Tau/resources/app.asar.unpacked/dist-electron/main/headless.js")).toEqual(["/opt/Tau/tau", "--ozone-platform=x11"]);
    expect(windowProgram("/w/node_modules/electron/dist/electron", "/w/dist-electron/main/headless.js")).toEqual(["/w/node_modules/electron/dist/electron", "/w", "--ozone-platform=x11"]);
  });

  it("writes one MIT cookie for the display in Xauthority's format", () => {
    const cookie = Buffer.alloc(16, 0xab);
    const bytes = renderXauthority(99, cookie);
    expect([...bytes.subarray(0, 6)]).toEqual([0xff, 0xff, 0, 0, 0, 2]);
    expect(bytes.subarray(6, 8).toString()).toBe("99");
    expect(bytes.readUInt16BE(8)).toBe(18);
    expect(bytes.subarray(10, 28).toString()).toBe("MIT-MAGIC-COOKIE-1");
    expect(bytes.readUInt16BE(28)).toBe(16);
    expect(bytes.subarray(30)).toEqual(cookie);
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
