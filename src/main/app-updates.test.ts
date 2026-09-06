import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  Menu: { getApplicationMenu: () => null, setApplicationMenu: vi.fn() },
  MenuItem: class {},
  dialog: { showMessageBox: vi.fn() },
}));

const { createAppUpdates } = await import("./app-updates.js");
type Listener = (payload: never) => void;

/** Stands in for electron-updater's `autoUpdater`, with its events under control. */
function fakeUpdater() {
  const listeners = new Map<string, Listener[]>();
  const updater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
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

function updates(overrides: { enabled?: boolean } = {}) {
  const { updater, emit } = fakeUpdater();
  const told: string[] = [];
  const downloaded: string[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const subject = createAppUpdates({
    updater,
    enabled: overrides.enabled ?? true,
    log,
    onDownloaded: (version) => downloaded.push(version),
    tell: (message) => told.push(message),
    startupDelayMs: 0,
  });
  return { subject, updater, emit, told, downloaded, log };
}

describe("app updates", () => {
  it("downloads by itself and installs on quit", () => {
    const { updater } = updates();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it("checks on startup once the app has settled", async () => {
    vi.useFakeTimers();
    const { subject, updater } = updates();
    subject.checkOnStartup();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("never checks from a checkout", async () => {
    vi.useFakeTimers();
    const { subject, updater, log } = updates({ enabled: false });
    subject.checkOnStartup();
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
});
