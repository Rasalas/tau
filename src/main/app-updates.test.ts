import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  dialog: { showMessageBox: vi.fn() },
}));

const { EventEmitter } = await import("node:events");
const { UNPACKED_UPDATES, createAppUpdates, linuxInstall, linuxUpdates, nextStaging, readUpdateFeed } = await import("./app-updates.js");
type InstallStep = import("./app-updates.js").InstallStep;
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
    downloadUpdate: vi.fn(async () => undefined as unknown),
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

function updates(overrides: { enabled?: boolean; unsupported?: string; installOnQuit?: boolean; channel?: () => Promise<"stable" | "nightly" | undefined>; currentVersion?: string; feed?: { owner: string; repo: string } | null; whenStaged?: () => Promise<void>; checkBeforeInstallMs?: number } = {}) {
  const { updater, emit } = fakeUpdater();
  const told: string[] = [];
  const downloaded: string[] = [];
  const steps: InstallStep[] = [];
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
    noticeMs: 0,
    onInstallStep: (step) => steps.push(step),
    ...(overrides.whenStaged ? { whenStaged: overrides.whenStaged } : {}),
    ...(overrides.checkBeforeInstallMs === undefined ? {} : { checkBeforeInstallMs: overrides.checkBeforeInstallMs }),
    ...(overrides.feed === null ? {} : { feed: overrides.feed ?? { owner: "Rasalas", repo: "tau-releases" } }),
    ...(overrides.channel ? { channel: overrides.channel } : {}),
    ...(overrides.currentVersion ? { currentVersion: overrides.currentVersion } : {}),
  });
  return { subject, updater, emit, told, downloaded, steps, log };
}

/** The feed offers `version` at each check, as electron-updater reports it. */
function feedOffers(updater: ReturnType<typeof fakeUpdater>["updater"], emit: (event: string, payload: unknown) => void, version: () => string) {
  updater.checkForUpdates.mockImplementation(async () => { emit("update-available", { version: version() }); });
}

function fakeUnseen() {
  const { updater } = fakeUpdater();
  const subject = createAppUpdates({ updater, enabled: true, interactive: false, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, onDownloaded: () => undefined, tell: () => undefined });
  return { updater, subject };
}

describe("app updates", () => {
  it("installs for the host of its machine: at once when downloaded, else once the download is done (K103)", async () => {
    const { subject, updater, emit } = updates();
    feedOffers(updater, emit, () => "0.7.14");
    expect(subject.installs()).toBe(true);
    expect(subject.installWhenReady()).toMatchObject({ started: false });
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledOnce());
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    emit("update-downloaded", { version: "0.7.14" });
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    const again = updates();
    feedOffers(again.updater, again.emit, () => "0.7.14");
    again.emit("update-downloaded", { version: "0.7.14" });
    expect(again.subject.installWhenReady()).toEqual({ started: true });
    await vi.waitFor(() => expect(again.updater.quitAndInstall).toHaveBeenCalledOnce());
  });

  it("leaves installing to the host where nobody sees the window or it cannot update", () => {
    expect(updates({ unsupported: UNPACKED_UPDATES }).subject.installs()).toBe(false);
    expect(updates({ enabled: false }).subject.installs()).toBe(false);
    const { updater, subject } = fakeUnseen();
    expect(subject.installs()).toBe(false);
    expect(subject.installWhenReady().started).toBe(false);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("starts each download itself, never twice for one version, and installs on quit", () => {
    const { updater, emit } = updates();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    emit("update-available", { version: "0.2.0" });
    emit("update-available", { version: "0.2.0" });
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    emit("update-downloaded", { version: "0.2.0" });
    // electron-updater would hand the cached file to Squirrel.Mac again, which unpacks and verifies it again.
    emit("update-available", { version: "0.2.0" });
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
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

  it("keeps polling while a version waits for a restart, and replaces it with a newer release (K161)", async () => {
    vi.useFakeTimers();
    let latest = "0.7.23";
    const { subject, updater, emit, downloaded } = updates();
    feedOffers(updater, emit, () => latest);
    subject.start();
    await vi.advanceTimersByTimeAsync(1);
    emit("update-downloaded", { version: "0.7.23" });
    latest = "0.7.25";
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
    emit("update-downloaded", { version: "0.7.25" });
    expect(subject.downloaded()).toBe("0.7.25");
    expect(downloaded).toEqual(["0.7.23", "0.7.25"]);
    subject.stop();
    vi.useRealTimers();
  });

  it("never installs a stale version: Restart fetches the newer release first, then quits (K161)", async () => {
    let latest = "0.7.23";
    const { subject, updater, emit, steps } = updates();
    feedOffers(updater, emit, () => latest);
    await subject.checkForUpdates();
    emit("update-downloaded", { version: "0.7.23" });
    latest = "0.7.25";
    expect(subject.install()).toBe(true);
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledTimes(2));
    emit("download-progress", { percent: 41.7 });
    emit("download-progress", { percent: 41.9 });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(subject.install()).toBe(true);
    emit("update-downloaded", { version: "0.7.25" });
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(steps).toEqual([
      { version: "0.7.23", phase: "preparing" },
      { version: "0.7.25", phase: "downloading" },
      { version: "0.7.25", phase: "downloading", progress: 41 },
      { version: "0.7.25", phase: "installing" },
    ]);
  });

  it("installs the version on disk at once when the feed has nothing newer", async () => {
    const { subject, updater, emit, steps } = updates();
    feedOffers(updater, emit, () => "0.7.25");
    emit("update-available", { version: "0.7.25" });
    emit("update-downloaded", { version: "0.7.25" });
    subject.install();
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledOnce());
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(steps.at(-1)).toEqual({ version: "0.7.25", phase: "installing" });
  });

  it("installs the version on disk when the feed does not answer in time", async () => {
    vi.useFakeTimers();
    const { subject, updater, emit } = updates({ checkBeforeInstallMs: 5_000 });
    updater.checkForUpdates.mockImplementation(() => new Promise(() => undefined));
    emit("update-downloaded", { version: "0.7.25" });
    subject.install();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("leaves Restart in place when the newer release fails to download", async () => {
    let latest = "0.7.23";
    const { subject, updater, emit, steps, told } = updates();
    feedOffers(updater, emit, () => latest);
    await subject.checkForUpdates();
    emit("update-downloaded", { version: "0.7.23" });
    latest = "0.7.25";
    subject.install();
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledTimes(2));
    emit("error", new Error("net::ERR_CONNECTION_RESET"));
    expect(told.at(-1)).toBe("Tau 0.7.25 could not be downloaded: net::ERR_CONNECTION_RESET");
    expect(steps.at(-1)).toEqual({ version: "0.7.23" });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    // The next Restart asks the feed again.
    subject.install();
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledTimes(3));
  });

  it("counts a download as ready only once Squirrel.Mac staged it for ShipIt", async () => {
    let staged = () => {};
    const whenStaged = vi.fn(() => new Promise<void>((resolve) => { staged = resolve; }));
    let latest = "0.7.23";
    const { subject, updater, emit, steps } = updates({ whenStaged });
    feedOffers(updater, emit, () => latest);
    await subject.checkForUpdates();
    emit("update-downloaded", { version: "0.7.23" });
    expect(subject.downloaded()).toBeUndefined();
    staged();
    await vi.waitFor(() => expect(subject.downloaded()).toBe("0.7.23"));
    latest = "0.7.25";
    subject.install();
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalledTimes(2));
    emit("update-downloaded", { version: "0.7.25" });
    // ShipIt's request still names 0.7.23 until Squirrel is done with 0.7.25.
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(steps.at(-1)).toEqual({ version: "0.7.25", phase: "preparing" });
    staged();
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledOnce());
    expect(subject.downloaded()).toBe("0.7.25");
  });

  it("waits for the next staging of Squirrel.Mac, or its failure", async () => {
    const native = new EventEmitter();
    const done = nextStaging(native);
    native.emit("update-downloaded");
    await expect(done).resolves.toBeUndefined();
    expect(native.listenerCount("error")).toBe(0);
    const failed = nextStaging(native);
    native.emit("error", new Error("Code signature did not pass validation"));
    await expect(failed).rejects.toThrow("Code signature");
    expect(native.listenerCount("update-downloaded")).toBe(0);
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

  it("checks again with a version waiting, and says it is ready when it is the newest", async () => {
    const { subject, emit, updater, told } = updates();
    feedOffers(updater, emit, () => "0.2.0");
    emit("update-available", { version: "0.2.0" });
    emit("update-downloaded", { version: "0.2.0" });
    await subject.checkForUpdates();
    expect(told).toEqual(["Tau 0.2.0 is ready. Restart to install it."]);
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("installs only what was downloaded", async () => {
    const { subject, emit, updater } = updates();
    expect(subject.install()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    emit("update-downloaded", { version: "0.2.0" });
    expect(subject.install()).toBe(true);
    await vi.waitFor(() => expect(updater.quitAndInstall).toHaveBeenCalledTimes(1));
  });

  it("tells the user when installing failed, such as a closed password dialog", async () => {
    const { subject, emit, updater, told } = updates({ installOnQuit: false });
    expect(updater.autoInstallOnAppQuit).toBe(false);
    emit("update-downloaded", { version: "0.8.0" });
    // electron-updater's DebUpdater reports a failed `pkexec … dpkg -i` as an error event, within quitAndInstall.
    updater.quitAndInstall.mockImplementation(() => emit("error", new Error("Command pkexec --disable-internal-agent exited with code 126")));
    subject.install();
    await vi.waitFor(() => expect(told).toEqual(["Tau 0.8.0 was not installed: the password dialog was closed. Restart again to install it."]));
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
    const NIGHTLY_FEED = { provider: "generic", url: "https://github.com/Rasalas/tau-releases/releases/download/nightly" };

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
      expect(updater.setFeedURL).toHaveBeenLastCalledWith({ provider: "github", owner: "Rasalas", repo: "tau-releases" });
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
    expect(readUpdateFeed("owner: Rasalas\nrepo: tau-releases\nprovider: github\nupdaterCacheDirName: tau-pi-desktop-prototype-updater\n"))
      .toEqual({ owner: "Rasalas", repo: "tau-releases" });
    expect(readUpdateFeed("provider: generic\nurl: https://example.com/\n")).toBeUndefined();
    expect(readUpdateFeed("provider: github\nowner: Rasalas\n")).toBeUndefined();
  });
});
