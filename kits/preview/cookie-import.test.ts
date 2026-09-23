import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFixtureHome, type FixtureCookie } from "./cookie-fixtures.js";
import { cookieImportEnvironment, importCookies, listSites, listSources, runCookieImportCommand, type CookieImportEnvironment } from "./cookie-import.js";
import type { CookieToWrite } from "./cookie-read.js";
import { keychainKeyProvider } from "./cookie-keys.js";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

const NOW = Date.UTC(2026, 8, 23) / 1000;
const LATER = NOW + 86_400;

/** A fake home with fixture browsers, a fake keychain that counts its questions, and a jar that records. */
async function setup(cookies: Parameters<typeof writeFixtureHome>[1], platform: NodeJS.Platform = "darwin") {
  const home = await mkdtemp(join(tmpdir(), "tau-cookie-import-test-"));
  folders.push(home);
  writeFixtureHome(home, cookies, "fixture-secret");
  const asked: string[] = [];
  const written: Array<{ partition: string; cookie: CookieToWrite }> = [];
  let flushed = 0;
  let secret = "fixture-secret";
  const environment: CookieImportEnvironment = {
    paths: { platform, home },
    keys: { secret: async ({ service }) => { asked.push(service); return secret; } },
    jar: (partition) => ({
      set: async (cookie) => {
        if (cookie.name === "refused") throw new Error("Electron refused it");
        written.push({ partition, cookie });
      },
      flushStore: async () => { flushed += 1; },
    }),
    now: () => NOW * 1000,
  };
  return { home, environment, asked, written, flushed: () => flushed, setSecret: (next: string) => { secret = next; } };
}

const chrome: FixtureCookie[] = [
  { host: ".github.com", name: "logged_in", value: "yes", secure: true, sameSite: 1, expires: LATER },
  { host: "github.com", name: "__Host-session", value: "gh-secret", secure: true, httpOnly: true, sameSite: 2, expires: LATER },
  { host: ".google.com", name: "SID", value: "google-secret", secure: true, expires: LATER },
  { host: "localhost", name: "old", value: "expired", expires: NOW - 10 },
  { host: "localhost", name: "tau_fixture", value: "hello" },
  { host: "localhost", name: "refused", value: "x" },
];

describe("listing", () => {
  it("names installed browsers and their profiles without reading a cookie or the keychain", async () => {
    const { environment, asked } = await setup({ chrome });
    const sources = await listSources(environment);
    expect(sources.map((source) => source.id)).toEqual(["chrome", "firefox", "safari"]);
    expect(sources[0]).toEqual({ id: "chrome", name: "Chrome", engine: "chromium", keychain: "Chrome Safe Storage", profiles: [{ id: "Default", name: "Person 1" }, { id: "Profile 1", name: "Work" }] });
    expect(sources[1]?.profiles).toEqual([{ id: "Profiles/fixture.default", name: "default-release" }]);
    expect(asked).toEqual([]);
  });

  it("lists nothing where no browser is installed, and no Chromium browser on Windows", async () => {
    const empty = await mkdtemp(join(tmpdir(), "tau-cookie-import-test-"));
    folders.push(empty);
    const environment: CookieImportEnvironment = { paths: { platform: "darwin", home: empty }, keys: keychainKeyProvider, jar: () => { throw new Error("no jar"); } };
    await expect(listSources(environment)).resolves.toEqual([]);
    const { environment: windows } = await setup({ chrome }, "win32");
    await expect(listSources(windows)).resolves.toEqual([]);
  });

  it("counts a profile's cookies per site and decrypts nothing", async () => {
    const { environment, asked } = await setup({ chrome });
    await expect(listSites({ source: "chrome", profile: "Default" }, environment)).resolves.toEqual([
      { site: "github.com", cookies: 2 },
      { site: "google.com", cookies: 1 },
      { site: "localhost", cookies: 3 },
    ]);
    expect(asked).toEqual([]);
  });

  it("refuses a profile the browser does not list, however it is spelled", async () => {
    const { environment } = await setup({ chrome });
    await expect(listSites({ source: "chrome", profile: "../../../etc" }, environment)).rejects.toThrow(/^\[unknown-profile\]/u);
    await expect(listSites({ source: "netscape", profile: "Default" }, environment)).rejects.toThrow(/^\[unknown-source\]/u);
  });
});

describe("importing", () => {
  it("decrypts and writes only the chosen sites, after asking the keychain once", async () => {
    const { environment, asked, written, flushed } = await setup({ chrome });
    const result = await importCookies({ source: "chrome", profile: "Default", sites: ["github.com"], partition: "persist:tau-preview-work" }, environment);
    expect(result).toEqual({ imported: 2, skipped: 0, skippedSites: [] });
    expect(asked).toEqual(["Chrome Safe Storage"]);
    expect(written.map(({ partition }) => partition)).toEqual(["persist:tau-preview-work", "persist:tau-preview-work"]);
    expect(written.map(({ cookie }) => cookie)).toEqual([
      { url: "https://github.com/", name: "logged_in", value: "yes", domain: ".github.com", path: "/", secure: true, httpOnly: false, expirationDate: LATER, sameSite: "lax" },
      { url: "https://github.com/", name: "__Host-session", value: "gh-secret", path: "/", secure: true, httpOnly: true, expirationDate: LATER, sameSite: "strict" },
    ]);
    expect(written.some(({ cookie }) => cookie.value === "google-secret")).toBe(false);
    expect(flushed()).toBe(1);
  });

  it("drops expired cookies and counts the ones Electron refuses", async () => {
    const { environment, written } = await setup({ chrome });
    const result = await importCookies({ source: "chrome", profile: "Default", sites: ["localhost"], partition: "persist:tau-preview" }, environment);
    expect(result).toEqual({ imported: 1, skipped: 1, skippedSites: ["localhost"] });
    expect(written.map(({ cookie }) => cookie.name)).toEqual(["tau_fixture"]);
  });

  it("skips what a wrong key cannot open instead of writing garbage", async () => {
    const { environment, written, setSecret } = await setup({ chrome });
    setSecret("not-the-secret");
    const result = await importCookies({ source: "chrome", profile: "Default", sites: ["github.com"], partition: "persist:tau-preview" }, environment);
    expect(result).toEqual({ imported: 0, skipped: 2, skippedSites: ["github.com"] });
    expect(written).toEqual([]);
  });

  it("carries a keychain refusal to the dialog and writes nothing", async () => {
    const { environment, written } = await setup({ chrome });
    const refusing: CookieImportEnvironment = { ...environment, keys: { secret: () => Promise.reject(new Error("[keychain-denied] no")) } };
    await expect(importCookies({ source: "chrome", profile: "Default", sites: ["github.com"], partition: "persist:tau-preview" }, refusing)).rejects.toThrow(/^\[keychain-denied\]/u);
    expect(written).toEqual([]);
  });

  it("never asks the keychain for Firefox, Safari or a site with nothing encrypted", async () => {
    const { environment, asked, written } = await setup({
      chrome: [{ host: "localhost", name: "plain", value: "clear", plain: true }],
      firefox: [{ host: ".mozilla.org", name: "ff", value: "fox", expires: LATER }],
      safari: [{ host: "localhost", name: "sf", value: "safari", path: "/" }],
    });
    await importCookies({ source: "firefox", profile: "Profiles/fixture.default", sites: ["mozilla.org"], partition: "persist:tau-preview" }, environment);
    await importCookies({ source: "safari", profile: "default", sites: ["localhost"], partition: "persist:tau-preview" }, environment);
    await importCookies({ source: "chrome", profile: "Default", sites: ["localhost"], partition: "persist:tau-preview" }, environment);
    expect(asked).toEqual([]);
    expect(written.map(({ cookie }) => `${cookie.name}=${cookie.value}`)).toEqual(["ff=fox", "sf=safari", "plain=clear"]);
  });

  it("writes into Preview's partitions only", async () => {
    const { environment, asked } = await setup({ chrome });
    for (const partition of ["", "persist:workbench", "persist:tau-preview-../x", "tau-preview"]) {
      await expect(importCookies({ source: "chrome", profile: "Default", sites: ["github.com"], partition }, environment)).rejects.toThrow(/^\[unknown-profile\]/u);
    }
    expect(asked).toEqual([]);
  });

  it("does nothing without a chosen site", async () => {
    const { environment, asked } = await setup({ chrome });
    await expect(runCookieImportCommand("import", { source: "chrome", profile: "Default", sites: [], partition: "persist:tau-preview" }, environment)).resolves.toEqual({ imported: 0, skipped: 0, skippedSites: [] });
    expect(asked).toEqual([]);
  });

  it("uses the Linux passphrase, never a keychain, on Linux", async () => {
    const { environment, asked } = await setup({}, "linux");
    // The fixture home is laid out for macOS; a Linux Chrome lives in ~/.config.
    const { writeChromiumStore } = await import("./cookie-fixtures.js");
    writeChromiumStore(join(environment.paths.home, ".config", "google-chrome", "Default", "Cookies"), [{ host: "example.com", name: "p", value: "penguin" }], { secret: "peanuts", platform: "linux" });
    const result = await importCookies({ source: "chrome", profile: "Default", sites: ["example.com"], partition: "persist:tau-preview" }, environment);
    expect(result.imported).toBe(1);
    expect(asked).toEqual([]);
  });
});

describe("the environment", () => {
  it("reads fixture browsers and a fixture keychain when an instance names import roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-cookie-import-test-"));
    folders.push(root);
    writeFixtureHome(join(root, "browsers"), { chrome: [{ host: "localhost", name: "a", value: "b" }] }, "instance-secret");
    const environment = cookieImportEnvironment(() => ({ set: async () => undefined, flushStore: async () => undefined }), { TAU_IMPORT_ROOTS: root }, "darwin");
    expect(environment.paths.home).toBe(join(root, "browsers"));
    await expect(environment.keys.secret({ service: "Chrome Safe Storage", account: "Chrome" })).resolves.toBe("instance-secret");
    await expect(environment.keys.secret({ service: "Brave Safe Storage", account: "Brave" })).rejects.toThrow(/^\[keychain-missing\]/u);
  });

  it("never reaches the real keychain from a test", async () => {
    await expect(keychainKeyProvider.secret({ service: "Chrome Safe Storage", account: "Chrome" })).rejects.toThrow(/never read under test/u);
  });
});
