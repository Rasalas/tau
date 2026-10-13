import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, dialog: { showMessageBox: vi.fn() } }));
const { createAppUpdates, linuxUpdates } = await import("./app-updates.js");
type InstallDownloaded = import("./app-updates.js").AppUpdatesOptions["installDownloaded"];
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const key = publicKey.export({ type: "spki", format: "pem" }).toString();
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function fixture(extension: string, tampered = false, installDownloaded?: InstallDownloaded) {
  const bytes = Buffer.from("trusted installer");
  const file = { url: `Tau_0.8.0_amd64.${extension}`, sha512: createHash("sha512").update(bytes).digest("base64"), size: bytes.length };
  const text = `version: 0.8.0\nfiles:\n  - url: ${file.url}\n    sha512: ${file.sha512}\n    size: ${file.size}\n`;
  const signature = sign(null, Buffer.from(text), privateKey).toString("base64");
  const folder = mkdtempSync(join(tmpdir(), "tau-update-security-"));
  folders.push(folder);
  const downloadedFile = join(folder, file.url);
  writeFileSync(downloadedFile, bytes);
  const events = new EventEmitter();
  const info = { version: "0.8.0", files: [file], downloadedFile };
  const install = vi.fn(() => true);
  const updater = Object.assign(events, {
    autoDownload: false, autoInstallOnAppQuit: false, allowPrerelease: false, allowDowngrade: false,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => { events.emit("update-available", info); }),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(() => { updater.install(); }),
    install,
  });
  const downloaded = vi.fn();
  const tell = vi.fn();
  const subject = createAppUpdates({ updater, enabled: true, feed: { owner: "test", repo: "releases" }, releaseKeys: [key], currentVersion: "0.7.0", noticeMs: 0,
    fetch: async (url) => new Response(url.endsWith(".sig") ? signature : tampered ? text.replace(file.sha512, "untrusted") : text),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, onDownloaded: downloaded, tell,
    ...(installDownloaded ? { installDownloaded, installOnQuit: false } : {}),
  });
  return { subject, updater, events, info, downloadedFile, downloaded, tell, install };
}

describe("signed desktop updates", () => {
  it.each(["deb", "exe"])("rejects a modified stable feed for %s before the updater downloads", async (extension) => {
    const test = fixture(extension, true);
    await test.subject.checkForUpdates();
    expect(test.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(test.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(test.tell).toHaveBeenCalledWith(expect.stringContaining("not signed"));
  });

  it.each(["deb", "exe"])("rejects a second feed with an attacker checksum for %s", async (extension) => {
    const test = fixture(extension);
    test.info.files[0]!.sha512 = createHash("sha512").update("attacker installer").digest("base64");
    await test.subject.checkForUpdates();
    expect(test.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(test.subject.downloaded()).toBeUndefined();
  });

  it.each(["deb", "exe"])("checks the downloaded %s bytes against the signed checksum", async (extension) => {
    const test = fixture(extension);
    await test.subject.checkForUpdates();
    writeFileSync(test.downloadedFile, "attacker installer");
    test.events.emit("update-downloaded", test.info);
    expect(test.downloaded).not.toHaveBeenCalled();
    expect(test.subject.install()).toBe(false);
    expect(test.updater.autoInstallOnAppQuit).toBe(false);
  });

  it("accepts a signed update and rechecks the cache on automatic installation", async () => {
    const test = fixture("exe");
    await test.subject.checkForUpdates();
    test.events.emit("update-downloaded", test.info);
    expect(test.subject.downloaded()).toBe("0.8.0");
    writeFileSync(test.downloadedFile, "changed after download");
    expect(test.updater.install()).toBe(false);
    expect(test.install).not.toHaveBeenCalled();
  });

  it("clears an earlier verified download when the updater replaces it with invalid bytes", async () => {
    const test = fixture("exe");
    await test.subject.checkForUpdates();
    test.events.emit("update-downloaded", test.info);
    writeFileSync(test.downloadedFile, "replacement installer");
    test.events.emit("update-downloaded", test.info);
    expect(test.subject.downloaded()).toBeUndefined();
    expect(test.updater.install()).toBe(false);
    expect(test.install).not.toHaveBeenCalled();
  });

  it("installs the verified .deb through the root helper with stdin, then restarts", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const restart = vi.fn();
    const updaters = { DebUpdater: class {} } as unknown as Parameters<typeof linuxUpdates>[0];
    const system = { run } as unknown as import("./update-installers.js").InstallerSystem;
    const linux = linuxUpdates(updaters, "deb", system, restart);
    const test = fixture("deb", false, linux.installDownloaded);
    await test.subject.checkForUpdates();
    test.events.emit("update-downloaded", test.info);
    expect(test.subject.install()).toBe(true);
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledWith("/usr/bin/pkexec", ["--disable-internal-agent", "/opt/Tau/bin/tau-update-helper", "install", "--version", "0.8.0", "--channel", "stable"], { stdinFile: test.downloadedFile, timeoutMs: 15 * 60_000 });
    expect(test.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(test.install).not.toHaveBeenCalled();
    expect(test.updater.autoInstallOnAppQuit).toBe(false);
  });

  it.each(["deb", "exe"])("rehashes the %s cache before Restart", async (extension) => {
    const test = fixture(extension);
    await test.subject.checkForUpdates();
    test.events.emit("update-downloaded", test.info);
    writeFileSync(test.downloadedFile, "changed after download");
    test.subject.install();
    await vi.waitFor(() => expect(test.tell).toHaveBeenCalledWith(expect.stringContaining("checksum")));
    expect(test.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});
