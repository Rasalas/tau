import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appImageSituation,
  downloadVerified,
  environmentOutsideAppImage,
  installCommand,
  installFailure,
  offerPackageInstall,
  packageFile,
  parseReleaseInfo,
  releaseFeedUrl,
  releaseInfoFile,
  terminalCommand,
  type CommandResult,
  type InstallPrompt,
  type InstallSystem,
  type PackageInstallOptions,
} from "./appimage-install.js";

const DEB = Buffer.from("a stand-in for Tau_0.7.5_amd64.deb");
const DEB_SHA512 = createHash("sha512").update(DEB).digest("base64");

/** electron-builder's `latest-linux.yml` of a release, trimmed to its shape. */
const RELEASE_INFO = `version: 0.7.5
files:
  - url: Tau-0.7.5.AppImage
    sha512: aW1hZ2U=
    size: 123
    blockMapSize: 456
  - url: Tau_0.7.5_amd64.deb
    sha512: ${DEB_SHA512}
    size: ${DEB.length}
path: Tau-0.7.5.AppImage
sha512: aW1hZ2U=
releaseDate: '2026-09-26T10:00:00.000Z'
`;

const APPIMAGE_ENV = {
  APPIMAGE: "/home/u/Downloads/Tau-0.7.5.AppImage",
  APPDIR: "/tmp/.mount_TauAbC",
  ARGV0: "./Tau-0.7.5.AppImage",
  OWD: "/home/u",
  PATH: "/tmp/.mount_TauAbC:/tmp/.mount_TauAbC/usr/sbin:/usr/local/bin:/usr/bin",
  LD_LIBRARY_PATH: "/tmp/.mount_TauAbC/usr/lib",
  XDG_DATA_DIRS: "/tmp/.mount_TauAbC/usr/share/:/usr/share/gnome:/usr/local/share/:/usr/share/",
  GSETTINGS_SCHEMA_DIR: "/tmp/.mount_TauAbC/usr/share/glib-2.0/schemas",
  HOME: "/home/u",
  TAU_USER_DATA: "/home/u/.config/tau-test",
};

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "tau-appimage-install-"));
  folders.push(folder);
  return folder;
}

interface FakeMachine {
  files?: string[];
  /** Exit code of `unshare -Ur true`; 1 where namespaces are refused. */
  unshare?: number;
  /** `dpkg-query` output for the installed package. */
  installed?: string;
  pkexec?: CommandResult;
  isRoot?: boolean;
}

/** A Debian machine that refuses user namespaces, with nothing of Tau installed. */
function fakeSystem(machine: FakeMachine = {}) {
  const files = new Set(machine.files ?? ["/usr/bin/dpkg", "/usr/bin/dpkg-query", "/usr/bin/apt-get", "/usr/bin/unshare", "/home/u", APPIMAGE_ENV.APPIMAGE]);
  const runs: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const relaunches: Array<{ pid: number; command: string; args: readonly string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
  const removed: string[] = [];
  const system: InstallSystem = {
    exists: (path) => files.has(path),
    run: async (command, args, env) => {
      runs.push({ command, args, env });
      if (command.endsWith("/unshare")) return { code: machine.unshare ?? 1, stdout: "", stderr: "" };
      if (command.endsWith("/dpkg-query")) {
        return machine.installed ? { code: 0, stdout: machine.installed, stderr: "" } : { code: 1, stdout: "", stderr: "dpkg-query: no packages found matching tau" };
      }
      if (command === "pkexec") {
        const result = machine.pkexec ?? { code: 0, stdout: "", stderr: "" };
        if (result.code === 0) files.add("/opt/Tau/tau");
        return result;
      }
      return { code: 127, stdout: "", stderr: `spawn ${command} ENOENT` };
    },
    relaunch: (pid, command, args, env, cwd) => { relaunches.push({ pid, command, args, env, cwd }); },
    remove: (path) => {
      removed.push(path);
      files.delete(path);
    },
    isRoot: machine.isRoot ?? false,
  };
  return { system, files, runs, relaunches, removed };
}

/** Answers boxes by their message; the download box stays open until the offer closes it. */
function fakeAsk(answers: Record<string, number> = {}) {
  const prompts: InstallPrompt[] = [];
  const ask = vi.fn(async (prompt: InstallPrompt, signal?: AbortSignal) => {
    prompts.push(prompt);
    if (prompt.message.startsWith("Downloading")) {
      if (answers.Downloading !== undefined) return answers.Downloading;
      return new Promise<number>((resolve) => {
        if (signal?.aborted) resolve(0);
        signal?.addEventListener("abort", () => resolve(0));
      });
    }
    return answers[prompt.message] ?? 0;
  });
  return { ask, prompts };
}

function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const urls: string[] = [];
  const fetch = vi.fn(async (url: string, init?: { signal?: AbortSignal }) => {
    urls.push(url);
    init?.signal?.throwIfAborted();
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  });
  return { fetch, urls };
}

const FEED = "http://127.0.0.1:8123/feed/";
const releaseRoutes = (deb: Buffer = DEB) => ({
  [`${FEED}latest-linux.yml`]: () => new Response(RELEASE_INFO),
  [`${FEED}Tau_0.7.5_amd64.deb`]: () => new Response(new Uint8Array(deb)),
});

function offer(overrides: Partial<PackageInstallOptions> & { system: InstallSystem }) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const copyText = vi.fn();
  const options: PackageInstallOptions = {
    env: { ...APPIMAGE_ENV, TAU_INSTALL_FEED_URL: FEED },
    version: "0.7.5",
    arch: "x64",
    pid: 4242,
    argv: ["--no-sandbox", "/home/u/project"],
    noSandbox: true,
    folder: tempFolder(),
    ask: fakeAsk().ask,
    copyText,
    fetch: fakeFetch(releaseRoutes()).fetch,
    log,
    ...overrides,
  };
  return { options, copyText, log, run: () => offerPackageInstall(options) };
}

const state = (folder: string) => JSON.parse(readFileSync(join(folder, "state.json"), "utf8")) as Record<string, unknown>;

describe("environmentOutsideAppImage", () => {
  it("drops what AppRun added and keeps the rest", () => {
    const env = environmentOutsideAppImage({ ...APPIMAGE_ENV, XDG_CURRENT_DESKTOP: "Unity", ORIGINAL_XDG_CURRENT_DESKTOP: "ubuntu:GNOME" });
    expect(env).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
      XDG_DATA_DIRS: "/usr/share/gnome:/usr/local/share/:/usr/share/",
      HOME: "/home/u",
      TAU_USER_DATA: "/home/u/.config/tau-test",
      XDG_CURRENT_DESKTOP: "ubuntu:GNOME",
    });
  });
});

describe("the release of this version", () => {
  it("is the version's tag, the moving nightly tag, or a local feed", () => {
    const feed = { owner: "Rasalas", repo: "tau-releases" };
    expect(releaseFeedUrl("0.7.5", feed, {})).toBe("https://github.com/Rasalas/tau-releases/releases/download/v0.7.5/");
    expect(releaseFeedUrl("0.7.6-nightly.20260927.3", feed, {})).toBe("https://github.com/Rasalas/tau-releases/releases/download/nightly/");
    expect(releaseFeedUrl("0.7.5", feed, { TAU_INSTALL_FEED_URL: "http://127.0.0.1:1/feed" })).toBe("http://127.0.0.1:1/feed/");
    expect(releaseFeedUrl("0.7.5", undefined, {})).toBeUndefined();
    expect(releaseInfoFile("x64")).toBe("latest-linux.yml");
    expect(releaseInfoFile("arm64")).toBe("latest-linux-arm64.yml");
  });

  it("reads the files of latest-linux.yml and picks the architecture's .deb", () => {
    const info = parseReleaseInfo(RELEASE_INFO);
    expect(info.version).toBe("0.7.5");
    expect(info.files).toEqual([
      { url: "Tau-0.7.5.AppImage", sha512: "aW1hZ2U=", size: 123 },
      { url: "Tau_0.7.5_amd64.deb", sha512: DEB_SHA512, size: DEB.length },
    ]);
    expect(packageFile(info, "x64", FEED)).toMatchObject({ href: `${FEED}Tau_0.7.5_amd64.deb`, name: "Tau_0.7.5_amd64.deb", sha512: DEB_SHA512 });
    expect(packageFile(info, "arm64", FEED)).toBeUndefined();
    expect(packageFile(info, "ia32", FEED)).toBeUndefined();
  });

  it("refuses a file name that would leave the download folder", () => {
    const info = { files: [{ url: "..%2F..%2Fevil_amd64.deb", sha512: "x" }] };
    expect(packageFile(info, "x64", FEED)).toBeUndefined();
  });
});

describe("downloadVerified", () => {
  it("keeps a download whose checksum and size match", async () => {
    const target = join(tempFolder(), "Tau_0.7.5_amd64.deb");
    const { fetch } = fakeFetch(releaseRoutes());
    await downloadVerified(fetch, `${FEED}Tau_0.7.5_amd64.deb`, target, { sha512: DEB_SHA512, size: DEB.length });
    expect(readFileSync(target)).toEqual(DEB);
  });

  it("throws a download away whose checksum does not match", async () => {
    const folder = tempFolder();
    const target = join(folder, "Tau_0.7.5_amd64.deb");
    const { fetch } = fakeFetch(releaseRoutes(Buffer.from("tampered")));
    await expect(downloadVerified(fetch, `${FEED}Tau_0.7.5_amd64.deb`, target, { sha512: DEB_SHA512 })).rejects.toThrow(/does not match the release's checksum/u);
    expect(readdirSync(folder)).toEqual([]);
  });

  it("throws a download away whose size does not match", async () => {
    const folder = tempFolder();
    const target = join(folder, "Tau_0.7.5_amd64.deb");
    const { fetch } = fakeFetch(releaseRoutes());
    await expect(downloadVerified(fetch, `${FEED}Tau_0.7.5_amd64.deb`, target, { sha512: DEB_SHA512, size: DEB.length + 1 })).rejects.toThrow(/checksum/u);
    expect(readdirSync(folder)).toEqual([]);
  });

  it("keeps a matching file from before without fetching it again", async () => {
    const target = join(tempFolder(), "Tau_0.7.5_amd64.deb");
    writeFileSync(target, DEB);
    const { fetch } = fakeFetch({});
    await downloadVerified(fetch, `${FEED}Tau_0.7.5_amd64.deb`, target, { sha512: DEB_SHA512 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a failed request", async () => {
    const { fetch } = fakeFetch({});
    await expect(downloadVerified(fetch, `${FEED}missing.deb`, join(tempFolder(), "x.deb"), { sha512: DEB_SHA512 })).rejects.toThrow(/answered 404/u);
  });
});

describe("the privileged step", () => {
  it("is one pkexec call that checks the package again as root before apt installs it", () => {
    const { command, args } = installCommand("/home/u/.config/tau/package-install/Tau_0.7.5_amd64.deb", DEB_SHA512);
    expect(command).toBe("pkexec");
    expect(args.slice(0, 3)).toEqual(["--disable-internal-agent", "/bin/sh", "-c"]);
    expect(args[3]).toMatch(/sha512sum --check/u);
    expect(args[3]).toMatch(/apt-get install -y/u);
    expect(args.slice(4)).toEqual(["sh", "/home/u/.config/tau/package-install/Tau_0.7.5_amd64.deb", Buffer.from(DEB_SHA512, "base64").toString("hex")]);
    expect(args.join(" ")).not.toMatch(/no-sandbox/u);
  });

  it("names what failed and when the terminal is the way left", () => {
    expect(installFailure({ code: 126, stdout: "", stderr: "Error executing command as another user: Not authorized" })).toEqual({ reason: "The password dialog was closed; nothing was installed.", terminal: false });
    expect(installFailure({ code: 127, stdout: "", stderr: "Error executing command as another user: No authentication agent found." })).toMatchObject({ reason: expect.stringMatching(/polkit agent/u), terminal: true });
    expect(installFailure({ code: 127, stdout: "", stderr: "spawn pkexec ENOENT" })).toMatchObject({ reason: expect.stringMatching(/pkexec is not installed/u), terminal: true });
    expect(installFailure({ code: 100, stdout: "", stderr: "E: Could not get lock /var/lib/dpkg/lock-frontend.\n" })).toEqual({ reason: "Installing failed (exit 100): E: Could not get lock /var/lib/dpkg/lock-frontend.", terminal: true });
    expect(terminalCommand("/home/u/My Tau/Tau_0.7.5_amd64.deb")).toBe("sudo apt install '/home/u/My Tau/Tau_0.7.5_amd64.deb'");
  });
});

describe("appImageSituation", () => {
  const base = { env: APPIMAGE_ENV, noSandbox: true, arch: "x64", version: "0.7.5" };

  it("is an offer for an AppImage without sandbox on a machine that refuses namespaces and has dpkg", async () => {
    const { system, runs } = fakeSystem();
    expect(await appImageSituation(base, system)).toEqual({});
    // The probes run outside the AppImage's library path.
    expect(runs[0]).toMatchObject({ command: "/usr/bin/unshare", args: ["-Ur", "true"] });
    expect(runs[0]!.env.LD_LIBRARY_PATH).toBeUndefined();
  });

  it("is nothing outside an AppImage, with the sandbox on, as root, or on another architecture", async () => {
    const { system } = fakeSystem();
    expect(await appImageSituation({ ...base, env: { HOME: "/home/u" } }, system)).toBeUndefined();
    expect(await appImageSituation({ ...base, noSandbox: false }, system)).toBeUndefined();
    expect(await appImageSituation({ ...base, arch: "ia32" }, system)).toBeUndefined();
    expect(await appImageSituation(base, fakeSystem({ isRoot: true }).system)).toBeUndefined();
  });

  it("is nothing on Fedora or Arch: no dpkg or apt", async () => {
    expect(await appImageSituation(base, fakeSystem({ files: ["/usr/bin/rpm", "/usr/bin/unshare"] }).system)).toBeUndefined();
    expect(await appImageSituation(base, fakeSystem({ files: ["/usr/bin/dpkg", "/usr/bin/unshare"] }).system)).toBeUndefined();
  });

  it("is nothing where namespaces work: --no-sandbox was the user's own", async () => {
    expect(await appImageSituation(base, fakeSystem({ unshare: 0 }).system)).toBeUndefined();
  });

  it("names an installed package at least as new, and ignores an older one", async () => {
    const files = ["/usr/bin/dpkg", "/usr/bin/dpkg-query", "/usr/bin/apt-get", "/usr/bin/unshare", "/opt/Tau/tau"];
    expect(await appImageSituation(base, fakeSystem({ files, installed: "installed 0.7.6" }).system)).toEqual({ installed: "0.7.6" });
    expect(await appImageSituation(base, fakeSystem({ files, installed: "installed 0.7.4" }).system)).toEqual({});
    expect(await appImageSituation(base, fakeSystem({ files, installed: "config-files 0.7.6" }).system)).toEqual({});
  });
});

describe("offerPackageInstall", () => {
  it("downloads, installs through pkexec and restarts from /opt/Tau without --no-sandbox", async () => {
    const machine = fakeSystem();
    const { ask, prompts } = fakeAsk();
    const { fetch, urls } = fakeFetch(releaseRoutes());
    const { options, run } = offer({ system: machine.system, ask, fetch });

    expect(await run()).toBe(true);
    expect(prompts.map((prompt) => prompt.message)).toEqual(["Install Tau properly (recommended)", "Downloading Tau 0.7.5…"]);
    expect(prompts[0]!.detail).toMatch(/preview/u);
    expect(urls).toEqual([`${FEED}latest-linux.yml`, `${FEED}Tau_0.7.5_amd64.deb`]);
    const pkexec = machine.runs.find((entry) => entry.command === "pkexec")!;
    const debPath = join(options.folder, "Tau_0.7.5_amd64.deb");
    expect(pkexec.args.slice(-2)).toEqual([debPath, Buffer.from(DEB_SHA512, "base64").toString("hex")]);
    expect(existsSync(debPath)).toBe(false);
    expect(machine.relaunches).toEqual([{
      pid: 4242,
      command: "/opt/Tau/tau",
      args: ["/home/u/project"],
      env: expect.not.objectContaining({ APPIMAGE: expect.anything() }),
      cwd: "/home/u",
    }]);
    expect(machine.relaunches[0]!.env.TAU_USER_DATA).toBe(APPIMAGE_ENV.TAU_USER_DATA);
    expect(state(options.folder)).toEqual({ replacedAppImage: APPIMAGE_ENV.APPIMAGE });
  });

  it("remembers Later until the next version", async () => {
    const machine = fakeSystem();
    const { ask } = fakeAsk({ "Install Tau properly (recommended)": 1 });
    const first = offer({ system: machine.system, ask });
    expect(await first.run()).toBe(false);
    expect(state(first.options.folder)).toEqual({ laterVersion: "0.7.5" });

    const again = offer({ system: machine.system, ask, folder: first.options.folder });
    expect(await again.run()).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);

    const next = offer({ system: machine.system, ask, folder: first.options.folder, version: "0.7.6" });
    await next.run();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("shows the one terminal command where no password dialog can open", async () => {
    const machine = fakeSystem({ pkexec: { code: 127, stdout: "", stderr: "Error executing command as another user: No authentication agent found." } });
    const { ask, prompts } = fakeAsk({ "Install Tau in a terminal": 0 });
    const { options, run, copyText } = offer({ system: machine.system, ask });

    expect(await run()).toBe(false);
    const debPath = join(options.folder, "Tau_0.7.5_amd64.deb");
    const box = prompts.at(-1)!;
    expect(box.message).toBe("Install Tau in a terminal");
    expect(box.detail).toContain(`sudo apt install ${debPath}`);
    expect(copyText).toHaveBeenCalledWith(`sudo apt install ${debPath}`);
    // The checked download stays for that command.
    expect(readFileSync(debPath)).toEqual(DEB);
    expect(machine.relaunches).toEqual([]);
  });

  it("asks again at the next start when the password dialog was closed", async () => {
    const machine = fakeSystem({ pkexec: { code: 126, stdout: "", stderr: "Error executing command as another user: Not authorized" } });
    const { ask, prompts } = fakeAsk();
    const { options, run } = offer({ system: machine.system, ask });
    expect(await run()).toBe(false);
    expect(prompts.at(-1)).toMatchObject({ message: "Tau was not installed", detail: expect.stringMatching(/password dialog was closed/u) });
    expect(existsSync(join(options.folder, "state.json"))).toBe(false);
  });

  it("installs nothing when the download does not match its checksum", async () => {
    const machine = fakeSystem();
    const { ask, prompts } = fakeAsk();
    const { fetch } = fakeFetch(releaseRoutes(Buffer.from("tampered")));
    const { run } = offer({ system: machine.system, ask, fetch });
    expect(await run()).toBe(false);
    expect(prompts.at(-1)).toMatchObject({ message: "Tau was not installed", detail: expect.stringMatching(/checksum/u) });
    expect(machine.runs.some((entry) => entry.command === "pkexec")).toBe(false);
  });

  it("stops quietly when the download is cancelled", async () => {
    const machine = fakeSystem();
    const { ask, prompts } = fakeAsk({ Downloading: 0 });
    // A feed that never answers until the request is cancelled.
    const fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) reject(init.signal.reason);
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      }));
    const { run } = offer({ system: machine.system, ask, fetch });
    expect(await run()).toBe(false);
    expect(prompts.map((prompt) => prompt.message)).toEqual(["Install Tau properly (recommended)", "Downloading Tau 0.7.5…"]);
    expect(machine.runs.some((entry) => entry.command === "pkexec")).toBe(false);
  });

  it("restarts into an installed package at least as new, without downloading", async () => {
    const machine = fakeSystem({ files: ["/usr/bin/dpkg", "/usr/bin/dpkg-query", "/usr/bin/apt-get", "/usr/bin/unshare", "/opt/Tau/tau"], installed: "installed 0.7.5" });
    const { ask, prompts } = fakeAsk();
    const { fetch } = fakeFetch({});
    const { run } = offer({ system: machine.system, ask, fetch });
    expect(await run()).toBe(true);
    expect(prompts.map((prompt) => prompt.message)).toEqual(["Use the installed Tau (recommended)"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(machine.relaunches[0]?.command).toBe("/opt/Tau/tau");
  });

  it("offers the installed Tau to delete the AppImage it replaced, once", async () => {
    const machine = fakeSystem();
    const folder = tempFolder();
    writeFileSync(join(folder, "state.json"), JSON.stringify({ replacedAppImage: APPIMAGE_ENV.APPIMAGE, laterVersion: "0.7.4" }));
    const { ask, prompts } = fakeAsk();
    const installed = offer({ system: machine.system, ask, folder, env: { HOME: "/home/u" } });
    expect(await installed.run()).toBe(false);
    expect(prompts.map((prompt) => prompt.message)).toEqual(["Tau is installed"]);
    expect(machine.removed).toEqual([APPIMAGE_ENV.APPIMAGE]);
    expect(state(folder)).toEqual({ laterVersion: "0.7.4" });

    await installed.run();
    expect(ask).toHaveBeenCalledTimes(1);
  });
});
