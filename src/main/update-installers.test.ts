import { describe, expect, it, vi } from "vitest";
import {
  UPDATE_HELPER,
  appImageInstaller,
  debInstaller,
  hostInstaller,
  macBundle,
  macInstaller,
  windowsInstaller,
  type CommandResult,
  type InstallerSystem,
} from "./update-installers.js";

const STAGED = { version: "0.7.14", channel: "stable" as const, file: "/data/updates/Tau_0.7.14_amd64.deb", sha512: "abc" };

function fakeSystem(options: { files?: string[]; writable?: string[]; run?: (command: string, args: readonly string[]) => CommandResult; list?: string[] } = {}) {
  const calls: Array<{ command: string; args: readonly string[]; stdinFile?: string }> = [];
  const moves: string[] = [];
  const system: InstallerSystem = {
    run: vi.fn(async (command, args, run = {}) => {
      calls.push({ command, args, ...(run.stdinFile ? { stdinFile: run.stdinFile } : {}) });
      return options.run?.(command, args) ?? { code: 0, stdout: "", stderr: "" };
    }),
    spawnDetached: vi.fn(),
    exists: (path) => (options.files ?? []).includes(path),
    writable: (path) => (options.writable ?? []).includes(path),
    mkdtemp: (prefix) => `${prefix}X`,
    rename: (from, to) => { moves.push(`${from} -> ${to}`); },
    copy: (from, to) => { moves.push(`copy ${from} -> ${to}`); },
    chmod: vi.fn(),
    remove: vi.fn(),
    list: () => options.list ?? [],
    readText: () => undefined,
  };
  return { system, calls, moves };
}

describe("debInstaller", () => {
  const present = [UPDATE_HELPER, "/usr/bin/pkexec", "/usr/bin/pkcheck"];

  it("hands the package to the root helper on its standard input, with only the version and channel as arguments", async () => {
    const { system, calls } = fakeSystem({ files: present });
    const installer = debInstaller(system, 42);
    expect(await installer.blocked()).toBeUndefined();
    expect(await installer.install(STAGED)).toBe("restart");
    expect(calls.at(-1)).toEqual({
      command: "/usr/bin/pkexec",
      args: ["--disable-internal-agent", UPDATE_HELPER, "install", "--version", "0.7.14", "--channel", "stable"],
      stdinFile: STAGED.file,
    });
    expect(calls[0]).toMatchObject({ command: "/usr/bin/pkcheck", args: ["--action-id", "de.tbuck.tau.update", "--process", "42"] });
  });

  it("is blocked without the helper, without pkexec, or where polkit would ask for a password", async () => {
    expect(await debInstaller(fakeSystem({ files: [] }).system).blocked()).toMatch(/once by hand/u);
    expect(await debInstaller(fakeSystem({ files: [UPDATE_HELPER] }).system).blocked()).toMatch(/pkexec/u);
    const asks = fakeSystem({ files: present, run: () => ({ code: 2, stdout: "", stderr: "" }) });
    expect(await debInstaller(asks.system).blocked()).toMatch(/administrator/u);
  });

  it("reports what the helper refused", async () => {
    const refused = fakeSystem({ files: present, run: (command) => command === "/usr/bin/pkexec" ? { code: 65, stdout: "", stderr: "tau-update-helper: the package does not match the release's checksum.\n" } : { code: 0, stdout: "", stderr: "" } });
    await expect(debInstaller(refused.system).install(STAGED)).rejects.toThrow("tau-update-helper: the package does not match the release's checksum");
    const denied = fakeSystem({ files: present, run: (command) => command === "/usr/bin/pkexec" ? { code: 126, stdout: "", stderr: "" } : { code: 0, stdout: "", stderr: "" } });
    await expect(debInstaller(denied.system).install(STAGED)).rejects.toThrow(/polkit/u);
  });
});

describe("appImageInstaller", () => {
  it("replaces the AppImage in its own folder", async () => {
    const { system, moves } = fakeSystem({ writable: ["/home/u/Apps", "/home/u/Apps/Tau.AppImage"] });
    const installer = appImageInstaller(system, "/home/u/Apps/Tau.AppImage");
    expect(await installer.blocked()).toBeUndefined();
    expect(await installer.install({ ...STAGED, file: "/data/updates/Tau-0.7.14.AppImage" })).toBe("restart");
    expect(moves).toEqual([
      `copy /data/updates/Tau-0.7.14.AppImage -> /home/u/Apps/Tau.AppImage.update-${process.pid}`,
      `/home/u/Apps/Tau.AppImage.update-${process.pid} -> /home/u/Apps/Tau.AppImage`,
    ]);
    expect(system.chmod).toHaveBeenCalledWith(`/home/u/Apps/Tau.AppImage.update-${process.pid}`, 0o755);
    expect(await appImageInstaller(fakeSystem().system, "/opt/Tau.AppImage").blocked()).toMatch(/not writable/u);
  });
});

describe("macInstaller", () => {
  const bundle = "/Applications/Tau.app";
  const plist = (id: string, version: string) => (command: string, args: readonly string[]): CommandResult => {
    if (command === "/usr/bin/plutil") {
      const key = args[1];
      const next = String(args[5]).includes(".tau-update-");
      if (key === "CFBundleIdentifier") return { code: 0, stdout: next ? id : "de.tbuck.tau", stderr: "" };
      return { code: 0, stdout: version, stderr: "" };
    }
    if (command === "/usr/bin/codesign" && args[0] === "-dv") return { code: 0, stdout: "", stderr: "Identifier=de.tbuck.tau\nTeamIdentifier=not set\n" };
    return { code: 0, stdout: "", stderr: "" };
  };

  it("finds the bundle it runs from", () => {
    expect(macBundle("/Applications/Tau.app/Contents/MacOS/Tau")).toBe(bundle);
    expect(macBundle("/usr/local/bin/node")).toBeUndefined();
  });

  it("unpacks beside the app, checks bundle id and version, and swaps it in", async () => {
    const { system, moves, calls } = fakeSystem({ writable: [bundle, "/Applications"], list: ["Tau.app"], run: plist("de.tbuck.tau", "0.7.14") });
    const installer = macInstaller(system, bundle);
    expect(await installer.blocked()).toBeUndefined();
    expect(await installer.install({ ...STAGED, file: "/data/updates/Tau-0.7.14-arm64-mac.zip" })).toBe("restart");
    expect(calls[0]).toMatchObject({ command: "/usr/bin/ditto", args: ["-x", "-k", "/data/updates/Tau-0.7.14-arm64-mac.zip", "/Applications/.tau-update-X"] });
    expect(moves).toEqual([
      "/Applications/Tau.app -> /Applications/.tau-update-X/previous.app",
      "/Applications/.tau-update-X/Tau.app -> /Applications/Tau.app",
    ]);
    expect(system.remove).toHaveBeenCalledWith("/Applications/.tau-update-X");
  });

  it("refuses another app or another version, and leaves the installed one alone", async () => {
    for (const [id, version, error] of [["com.example.other", "0.7.14", /another app/u], ["de.tbuck.tau", "0.7.13", /version 0\.7\.13/u]] as const) {
      const { system, moves } = fakeSystem({ writable: [bundle, "/Applications"], list: ["Tau.app"], run: plist(id, version) });
      await expect(macInstaller(system, bundle).install(STAGED)).rejects.toThrow(error);
      expect(moves).toEqual([]);
    }
  });

  it("requires a valid signature by the same team when the running app is signed", async () => {
    const signed = (nextTeam: string, valid: boolean) => (command: string, args: readonly string[]): CommandResult => {
      if (command === "/usr/bin/codesign" && args[0] === "-dv") {
        return { code: 0, stdout: "", stderr: `TeamIdentifier=${String(args[2]).includes(".tau-update-") ? nextTeam : "TEAM123"}\n` };
      }
      if (command === "/usr/bin/codesign") return valid ? { code: 0, stdout: "", stderr: "" } : { code: 1, stdout: "", stderr: "invalid signature" };
      return plist("de.tbuck.tau", "0.7.14")(command, args);
    };
    for (const [team, valid, error] of [["TEAM123", false, /not valid/u], ["OTHER", true, /signed by OTHER/u]] as const) {
      const { system, moves } = fakeSystem({ writable: [bundle, "/Applications"], list: ["Tau.app"], run: signed(team, valid) });
      await expect(macInstaller(system, bundle).install(STAGED)).rejects.toThrow(error);
      expect(moves).toEqual([]);
    }
    const good = fakeSystem({ writable: [bundle, "/Applications"], list: ["Tau.app"], run: signed("TEAM123", true) });
    expect(await macInstaller(good.system, bundle).install(STAGED)).toBe("restart");
  });

  it("is blocked where the user does not own the app", async () => {
    expect(await macInstaller(fakeSystem({ writable: ["/Applications"] }).system, bundle).blocked()).toMatch(/another user/u);
  });
});

describe("windowsInstaller", () => {
  it("runs the installer silently and detached, then starts the host's task again", async () => {
    const { system } = fakeSystem({ writable: ["C:\\Users\\u\\AppData\\Local\\Programs\\Tau"] });
    const installer = windowsInstaller(system, "C:\\Users\\u\\AppData\\Local\\Programs\\Tau/Tau.exe", "Tau Host");
    expect(await installer.blocked()).toBeUndefined();
    expect(await installer.install({ ...STAGED, file: "C:\\data\\Tau-Setup-0.7.14.exe" })).toBe("exit");
    expect(system.spawnDetached).toHaveBeenCalledWith("cmd.exe", ["/d", "/s", "/c", "\"timeout /t 3 /nobreak >nul & \"C:\\data\\Tau-Setup-0.7.14.exe\" /S --updated & schtasks /Run /TN \"Tau Host\"\""], { verbatim: true });
  });

  it("is blocked for an install for all users", async () => {
    expect(await windowsInstaller(fakeSystem().system, "C:\\Program Files\\Tau/Tau.exe", undefined).blocked()).toMatch(/all users/u);
  });
});

describe("hostInstaller", () => {
  const base = { env: {}, execPath: "/opt/Tau/tau" };
  it("picks the installer of the copy the host runs from", () => {
    const deb = fakeSystem();
    deb.system.readText = (path) => path === "/opt/Tau/resources/package-type" ? "deb\n" : undefined;
    expect(hostInstaller({ ...base, platform: "linux", appRoot: "/opt/Tau/resources/app.asar.unpacked", system: deb.system }).installer?.method).toBe("deb");
    expect(hostInstaller({ ...base, env: { APPIMAGE: "/home/u/Tau.AppImage" }, platform: "linux", appRoot: "/tmp/.mount_x/resources/app.asar.unpacked", system: fakeSystem().system }).installer?.method).toBe("appimage");
    expect(hostInstaller({ ...base, platform: "linux", appRoot: "/home/u/tau/resources/app.asar.unpacked", system: fakeSystem().system }).unsupported).toMatch(/unpacked by hand/u);
    expect(hostInstaller({ ...base, execPath: "/Applications/Tau.app/Contents/MacOS/Tau", platform: "darwin", appRoot: "/Applications/Tau.app/Contents/Resources/app.asar.unpacked", system: fakeSystem().system }).installer?.method).toBe("mac");
    expect(hostInstaller({ ...base, execPath: "C:\\Tau\\Tau.exe", platform: "win32", appRoot: "C:\\Tau\\resources\\app.asar.unpacked".replaceAll("\\", "/"), system: fakeSystem().system }).installer?.method).toBe("windows");
    expect(hostInstaller({ ...base, platform: "linux", appRoot: "/home/u/src/tau" }).unsupported).toMatch(/checkout/u);
    expect(hostInstaller({ ...base, env: { TAU_UPDATE_FAKE_INSTALL: "/tmp/marker" }, platform: "linux", appRoot: "/home/u/src/tau" }).installer).toBeDefined();
  });
});
