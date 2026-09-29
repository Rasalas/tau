import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  dialog: { showMessageBox: vi.fn() },
}));

const { UNPACKED_UPDATES, createAppUpdates, linuxInstall, linuxUpdates, readUpdateFeed } = await import("./app-updates.js");
type Listener = (payload: never) => void;

/** Stands in for electron-updater's `autoUpdater`, with its events under control. */
function fakeUpdater() {
  const listeners = new Map<string, Listener[]>();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => undefined as unknown),
    quitAndInstall: vi.fn(),
    on(event: string, listener: Listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return updater;
    },
  };
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners.get(event) ?? []) listener(payload as never);
  };
  return { updater, emit };
}

function updates(overrides: { enabled?: boolean; unsupported?: string; installOnQuit?: boolean; channel?: () => Promise<"stable" | "nightly" | undefined>; currentVersion?: string; feed?: { owner: string; repo: string } | null } = {}) {
  const { updater, emit } = fakeUpdater();
  const told: string[] = [];
  const downloaded: string[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const subject = createAppUpdates({
    updater,
    enabled: overrides.enabled ?? true,
    ...(overrides.unsupported ? { unsupported: overrides.unsupported } : {}),
    ...(overrides.installOnQuit === undefined ? {} : { installOnQuit: overrides.installOnQuit }),
    log,
    onDownloaded: (version) => downloaded.push(version),
    tell: (message) => told.push(message),
    startupDelayMs: 0,
    ...(overrides.feed === null ? {} : { feed: overrides.feed ?? { owner: "Rasalas", repo: "tau" } }),
    ...(overrides.channel ? { channel: overrides.channel } : {}),
    ...(overrides.currentVersion ? { currentVersion: overrides.currentVersion } : {}),
  });
  return { subject, updater, emit, told, downloaded, log };
}

function fakeUnseen() {
  const { updater } = fakeUpdater();
  const subject = createAppUpdates({ updater, enabled: true, interactive: false, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, onDownloaded: () => undefined, tell: () => undefined });
  return { updater, subject };
}

describe("app updates", () => {
  it("installs for the host of its machine: at once when downloaded, else once the download is done (K103)", async () => {
    const { subject, updater, emit } = updates();
    expect(subject.installs()).toBe(true);
    expect(subject.installWhenReady()).toMatchObject({ started: false });
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledOnce());
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    emit("update-downloaded", { version: "0.7.14" });
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    const again = updates();
    again.emit("update-downloaded", { version: "0.7.14" });
    expect(again.subject.installWhenReady()).toEqual({ started: true });
    expect(again.updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it("leaves installing to the host where nobody sees the window or it cannot update", () => {
    expect(updates({ unsupported: UNPACKED_UPDATES }).subject.installs()).toBe(false);
    expect(updates({ enabled: false }).subject.installs()).toBe(false);
    const { updater, subject } = fakeUnseen();
    expect(subject.installs()).toBe(false);
    expect(subject.installWhenReady().started).toBe(false);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("downloads by itself and installs on quit", () => {
    const { updater } = updates();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("checks on startup once the app has settled", async () => {
    vi.useFakeTimers();
    const { subject, updater } = updates();
    subject.start();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("checks again every poll interval, following the channel as it is then", async () => {
    vi.useFakeTimers();
    let channel: "stable" | "nightly" = "stable";
    const { subject, updater } = updates({ channel: async () => channel });
    subject.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    channel = "nightly";
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.allowPrerelease).toBe(true);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
    subject.stop();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("stops polling while a downloaded version waits for a restart", async () => {
    vi.useFakeTimers();
    const { subject, updater, emit } = updates();
    subject.start();
    await vi.advanceTimersByTimeAsync(1);
    emit("update-downloaded", { version: "0.2.0" });
    await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    subject.stop();
    vi.useRealTimers();
  });

  it("joins a check already in flight instead of starting a second one", async () => {
    const { subject, updater, emit, told } = updates();
    let finish = () => {};
    updater.checkForUpdates.mockImplementation(() => new Promise<void>((resolve) => { finish = () => { emit("update-not-available", { version: "0.1.0" }); resolve(); }; }));
    const asked = subject.checkForUpdates();
    const again = subject.checkForUpdates();
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalled());
    finish();
    await Promise.all([asked, again]);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(told).toEqual(["Tau is up to date."]);
  });

  it("hands the release notes of a download on", () => {
    const { updater, emit } = fakeUpdater();
    const onDownloaded = vi.fn();
    createAppUpdates({ updater, enabled: true, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, onDownloaded, tell: () => undefined });
    emit("update-downloaded", { version: "0.5.0", releaseNotes: "## What's Changed\n* One thing" });
    expect(onDownloaded).toHaveBeenCalledWith("0.5.0", { version: "0.5.0", releaseNotes: "## What's Changed\n* One thing" });
  });

  it("never checks from a checkout", async () => {
    vi.useFakeTimers();
    const { subject, updater, log } = updates({ enabled: false });
    subject.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("update.disabled", expect.any(String));
    vi.useRealTimers();
  });

  it("announces a downloaded version to the workbench", () => {
    const { subject, emit, downloaded } = updates();
    emit("update-downloaded", { version: "0.2.0" });
    expect(downloaded).toEqual(["0.2.0"]);
    expect(subject.downloaded()).toBe("0.2.0");
  });

  it("keeps a check nobody asked for silent", () => {
    const { emit, told } = updates();
    emit("update-not-available", { version: "0.1.0" });
    emit("error", new Error("no network"));
    expect(told).toEqual([]);
  });

  it("reports the outcome of a check the user asked for", async () => {
    const { subject, emit, updater, told } = updates();
    updater.checkForUpdates.mockImplementation(async () => { emit("update-not-available", { version: "0.1.0" }); });
    await subject.checkForUpdates();
    expect(told).toEqual(["Tau is up to date."]);
  });

  it("reports a failed check the user asked for, without the feed's headers", async () => {
    const { subject, updater, told, log } = updates();
    updater.checkForUpdates.mockRejectedValueOnce(new Error('404 from the feed\nHeaders: {\n  "server": "github.com"\n}'));
    await subject.checkForUpdates();
    expect(told).toEqual(["The update check failed: 404 from the feed"]);
    expect(log.warn).toHaveBeenCalledWith("update.check.failed", expect.any(Error));
  });

  it("logs a failure once, though the updater both emits and rejects with it", async () => {
    const { subject, updater, emit, log } = updates();
    const failure = new Error("404 from the feed");
    updater.checkForUpdates.mockImplementation(async () => { emit("error", failure); throw failure; });
    await subject.checkForUpdates();
    expect(log.warn.mock.calls).toEqual([["update.failed", failure]]);
  });

  it("tells a checkout to update itself the way it was built", async () => {
    const { subject, updater, told } = updates({ enabled: false });
    await subject.checkForUpdates();
    expect(told).toEqual(["This Tau runs from a checkout, so it updates with `git pull` and `npm run build`."]);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("does not check again once a version is waiting", async () => {
    const { subject, emit, updater, told } = updates();
    emit("update-downloaded", { version: "0.2.0" });
    await subject.checkForUpdates();
    expect(told).toEqual(["Tau 0.2.0 is ready. Restart to install it."]);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("installs only what was downloaded", () => {
    const { subject, emit, updater } = updates();
    expect(subject.install()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    emit("update-downloaded", { version: "0.2.0" });
    expect(subject.install()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("tells the user when installing failed, such as a closed password dialog", () => {
    const { subject, emit, updater, told } = updates({ installOnQuit: false });
    expect(updater.autoInstallOnAppQuit).toBe(false);
    emit("update-downloaded", { version: "0.8.0" });
    // electron-updater's DebUpdater reports a failed `pkexec … dpkg -i` as an error event, within quitAndInstall.
    updater.quitAndInstall.mockImplementation(() => emit("error", new Error("Command pkexec --disable-internal-agent exited with code 126")));
    subject.install();
    expect(told).toEqual(["Tau 0.8.0 was not installed: the password dialog was closed. Restart again to install it."]);
    // A later failed background check stays quiet again.
    emit("error", new Error("net::ERR_INTERNET_DISCONNECTED"));
    expect(told).toHaveLength(1);
  });

  it("says why an installed copy cannot update itself, and never checks", async () => {
    vi.useFakeTimers();
    const { subject, updater, told } = updates({ unsupported: UNPACKED_UPDATES });
    subject.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await subject.checkForUpdates();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(told).toEqual([UNPACKED_UPDATES]);
    subject.stop();
    vi.useRealTimers();
  });

  describe("on Linux", () => {
    const deb = (path: string) => (path === "/opt/Tau/resources/package-type" ? "deb\n" : undefined);

    it("tells an AppImage, the .deb and a copy unpacked by hand apart", () => {
      expect(linuxInstall({ APPIMAGE: "/home/me/Tau.AppImage" }, "/tmp/.mount_Tau/resources", "/tmp/.mount_Tau/tau", deb)).toBe("appimage");
      expect(linuxInstall({}, "/opt/Tau/resources", "/opt/Tau/tau", deb)).toBe("deb");
      // The folder both packages are made from may leave `deb` in an extracted AppImage.
      expect(linuxInstall({}, "/home/me/Tau/resources", "/home/me/Tau/tau", () => "deb")).toBe("unpacked");
      expect(linuxInstall({}, "/opt/Tau/resources", "/opt/Tau/tau", () => undefined)).toBe("unpacked");
    });

    it("installs a .deb only on Restart, and leaves an unpacked copy alone", () => {
      class AppImageUpdater { kind = "appimage"; }
      class DebUpdater { kind = "deb"; }
      const updaters = { AppImageUpdater, DebUpdater } as unknown as Parameters<typeof linuxUpdates>[0];
      expect(linuxUpdates(updaters, "appimage")).toEqual({ updater: expect.objectContaining({ kind: "appimage" }) });
      expect(linuxUpdates(updaters, "deb")).toEqual({ updater: expect.objectContaining({ kind: "deb" }), installOnQuit: false });
      expect(linuxUpdates(updaters, "unpacked")).toEqual({ unsupported: UNPACKED_UPDATES });
    });
  });

  describe("channels", () => {
    const NIGHTLY_FEED = { provider: "generic", url: "https://github.com/Rasalas/tau/releases/download/nightly" };

    it("keeps the build's own feed on stable and never takes a prerelease", async () => {
      const { subject, updater } = updates();
      await subject.checkForUpdates();
      expect(updater.setFeedURL).not.toHaveBeenCalled();
      expect(updater.allowPrerelease).toBe(false);
      expect(updater.allowDowngrade).toBe(false);
    });

    it("reads the nightly tag as a plain feed and never goes back from there", async () => {
      const { subject, updater } = updates({ channel: async () => "nightly", currentVersion: "0.4.0" });
      await subject.checkForUpdates();
      expect(updater.setFeedURL).toHaveBeenCalledWith(NIGHTLY_FEED);
      expect(updater.allowPrerelease).toBe(true);
      expect(updater.allowDowngrade).toBe(false);
    });

    it("lets a nightly build go back to the latest stable release", async () => {
      const { subject, updater } = updates({ channel: async () => "stable", currentVersion: "0.4.1-nightly.20260922.17" });
      await subject.checkForUpdates();
      expect(updater.allowPrerelease).toBe(false);
      expect(updater.allowDowngrade).toBe(true);
    });

    it("stays on stable when the build names no feed", async () => {
      const { subject, updater, log } = updates({ channel: async () => "nightly", feed: null });
      await subject.checkForUpdates();
      expect(updater.setFeedURL).not.toHaveBeenCalled();
      expect(updater.allowPrerelease).toBe(false);
      expect(log.warn).toHaveBeenCalledWith("update.channel.unavailable", expect.any(String));
    });

    it("checks again at once when the channel moved, and only then", async () => {
      let channel: "stable" | "nightly" = "stable";
      const { subject, updater } = updates({ channel: async () => channel, currentVersion: "0.4.0" });
      await subject.checkForUpdates();
      await subject.channelChanged();
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

      channel = "nightly";
      await subject.channelChanged();
      expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
      expect(updater.setFeedURL).toHaveBeenLastCalledWith(NIGHTLY_FEED);

      channel = "stable";
      await subject.channelChanged();
      expect(updater.setFeedURL).toHaveBeenLastCalledWith({ provider: "github", owner: "Rasalas", repo: "tau" });
      expect(updater.allowPrerelease).toBe(false);
    });

    it("waits for the first check before a config change counts", async () => {
      const { subject, updater } = updates({ channel: async () => "nightly" });
      await subject.channelChanged();
      expect(updater.checkForUpdates).not.toHaveBeenCalled();
    });

    it("falls back to the running build's own channel when none is set or the config cannot be read", async () => {
      const unreadable = updates({ channel: async () => { throw new Error("EACCES"); } });
      await unreadable.subject.checkForUpdates();
      expect(unreadable.updater.allowPrerelease).toBe(false);

      // A nightly someone installed by hand must not fall back to stable on its first check.
      const nightly = updates({ channel: async () => undefined, currentVersion: "0.4.1-nightly.20260922.17" });
      await nightly.subject.checkForUpdates();
      expect(nightly.updater.setFeedURL).toHaveBeenCalledWith(NIGHTLY_FEED);
      expect(nightly.updater.allowDowngrade).toBe(false);
    });
  });

  it("reads the GitHub feed electron-builder writes into app-update.yml", () => {
    expect(readUpdateFeed("owner: Rasalas\nrepo: tau\nprovider: github\nupdaterCacheDirName: tau-pi-desktop-prototype-updater\n"))
      .toEqual({ owner: "Rasalas", repo: "tau" });
    expect(readUpdateFeed("provider: generic\nurl: https://example.com/\n")).toBeUndefined();
    expect(readUpdateFeed("provider: github\nowner: Rasalas\n")).toBeUndefined();
  });
});
