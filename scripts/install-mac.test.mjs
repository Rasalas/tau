import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_IDENTITIES, FLAVOR_FIELD } from "../src/main/app-identity.ts";
import { devBuilderConfig } from "./packaging/dev-app.mjs";
import { RELEASED_APP, cliPath, dmgPattern, downloadChecked, localAppPath, localBuildArgs, localInstallTarget, parseArgs, pickDmg, quitScript, readRelease, releaseUrl, updateFeedPath } from "./install-mac.mjs";

const DMG = Buffer.from("a disk image");
const SHA512 = createHash("sha512").update(DMG).digest("base64");
const FEED = `version: 0.7.15\nfiles:\n  - url: Tau-0.7.15-arm64-mac.zip\n    sha512: x==\n    size: 1\n  - url: Tau-0.7.15-arm64.dmg\n    sha512: ${SHA512}\n    size: ${DMG.length}\n  - url: Tau-0.7.15.dmg\n    sha512: y==\n    size: 2\npath: Tau-0.7.15-arm64-mac.zip\n`;

function releaseKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { raw: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"), sign: (text) => sign(null, Buffer.from(text), privateKey).toString("base64") };
}

/** The public release repository: `files` by URL, anything else answers 404. */
function fakeReleases(files) {
  return vi.fn(async (url) => url in files ? new Response(files[url]) : new Response("Not Found", { status: 404 }));
}

const folders = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("install-mac", () => {
  it("parses the version and open flags", () => {
    expect(parseArgs([])).toEqual({ version: undefined, open: false, local: false, help: false });
    expect(parseArgs(["--version", "v0.1.1", "--open"])).toEqual({ version: "v0.1.1", open: true, local: false, help: false });
    expect(parseArgs(["--local"])).toMatchObject({ local: true });
    expect(() => parseArgs(["--local", "--version", "v0.1.1"])).toThrow("takes no --version");
    expect(() => parseArgs(["--version"])).toThrow("--version needs a tag");
    expect(() => parseArgs(["--linux"])).toThrow("unknown flag");
  });

  it("picks the image that matches the architecture", () => {
    const names = ["Tau-0.1.2-arm64.dmg", "Tau-0.1.2-arm64.dmg.blockmap", "Tau-0.1.2.dmg", "Tau-0.1.2.dmg.blockmap", "Tau-0.1.2.AppImage"];
    expect(pickDmg(names, "arm64")).toBe("Tau-0.1.2-arm64.dmg");
    expect(pickDmg(names, "x64")).toBe("Tau-0.1.2.dmg");
    expect(() => pickDmg(["Tau-0.1.2.AppImage"], "arm64")).toThrow("expected one .dmg");
    expect(dmgPattern("arm64")).toBe("Tau-*-arm64.dmg");
  });

  it("builds this checkout as Tau Dev, beside the released app and without a feed", () => {
    const dev = APP_IDENTITIES.dev;
    expect(localBuildArgs("arm64")).toEqual(["electron-builder", "-c", "tooling/electron-builder.dev.mjs", "--mac", "--dir", "--arm64", "--publish", "never"]);
    expect(localBuildArgs("x64")).toContain("--x64");
    expect(() => localBuildArgs("ia32")).toThrow("Unsupported architecture");
    expect(localAppPath("arm64", dev.productName)).toBe(join("release", "dev", "mac-arm64", "Tau Dev.app"));
    expect(localAppPath("x64", dev.productName)).toBe(join("release", "dev", "mac", "Tau Dev.app"));
    expect(localInstallTarget(dev)).toBe("/Applications/Tau Dev.app");
    expect(() => localInstallTarget(APP_IDENTITIES.stable)).toThrow("must not replace /Applications/Tau.app");
    expect(updateFeedPath("release/dev/mac-arm64/Tau Dev.app")).toBe(join("release", "dev", "mac-arm64", "Tau Dev.app", "Contents", "Resources", "app-update.yml"));
  });

  it("quits only the app it replaces, by bundle id", () => {
    expect(quitScript("de.tbuck.tau.dev")).toBe('if application id "de.tbuck.tau.dev" is running then tell application id "de.tbuck.tau.dev" to quit');
    const { productName, appId, cliName } = APP_IDENTITIES.stable;
    expect(RELEASED_APP).toEqual({ productName, appId, cliName });
  });

  it("gives Tau Dev's build the identity's names, its icon and no release feed", () => {
    const dev = APP_IDENTITIES.dev;
    const config = devBuilderConfig(dev, FLAVOR_FIELD);
    expect(config).toMatchObject({ appId: "de.tbuck.tau.dev", productName: "Tau Dev", extraMetadata: { tauFlavor: "dev" }, publish: null });
    expect(config.extends).toBe("tooling/electron-builder.yml");
    expect(config.asarUnpack).toEqual(["package.json"]);
    expect(config.mac.icon).toBe("assets/icon/TauDev.icon");
    expect(existsSync(new URL(`../${config.mac.icon}/icon.json`, import.meta.url))).toBe(true);
    expect(config.mac.extendInfo.NSBonjourServices).toEqual([dev.bonjourType]);
    // Its output stays inside release/, which the base configuration keeps out of the archive.
    expect(config.directories.output.startsWith("release/")).toBe(true);
    // The released app keeps its feed; only the dev configuration drops it.
    const builder = readFileSync(new URL("../tooling/electron-builder.yml", import.meta.url), "utf8");
    expect(builder).toMatch(/^publish:\n  provider: github\n  owner: Rasalas\n  repo: tau-releases$/mu);
  });

  it("names the command line inside the installed bundle", () => {
    expect(cliPath("/Applications/Tau.app")).toBe("/Applications/Tau.app/Contents/Resources/app.asar.unpacked/bin/tau.mjs");
  });

  it("downloads from the public release repository, without a login", () => {
    expect(releaseUrl(undefined, "latest-mac.yml")).toBe("https://github.com/Rasalas/tau-releases/releases/latest/download/latest-mac.yml");
    expect(releaseUrl("v0.7.15", "Tau-0.7.15-arm64.dmg")).toBe("https://github.com/Rasalas/tau-releases/releases/download/v0.7.15/Tau-0.7.15-arm64.dmg");
  });

  it("reads a release from its signed latest-mac.yml", async () => {
    const key = releaseKey();
    const latest = releaseUrl(undefined, "latest-mac.yml");
    const fetchUrl = fakeReleases({ [latest]: FEED, [`${latest}.sig`]: key.sign(FEED) });
    const release = await readRelease(fetchUrl, undefined, [key.raw]);
    expect(release.tag).toBe("v0.7.15");
    expect(pickDmg(release.files.map((file) => file.url), "arm64")).toBe("Tau-0.7.15-arm64.dmg");
    expect(pickDmg(release.files.map((file) => file.url), "x64")).toBe("Tau-0.7.15.dmg");
    expect(fetchUrl.mock.calls.map(([url]) => url)).toEqual([latest, `${latest}.sig`]);
    for (const [, init] of fetchUrl.mock.calls) expect(init).toBeUndefined();
  });

  it("has nothing for a tag the public repository lacks, so gh can look in the source repository", async () => {
    await expect(readRelease(fakeReleases({}), "v0.4.0", [releaseKey().raw])).resolves.toBeUndefined();
  });

  it("refuses a feed without the release key's signature, or for another version", async () => {
    const key = releaseKey();
    const tagged = releaseUrl("v0.7.15", "latest-mac.yml");
    await expect(readRelease(fakeReleases({ [tagged]: FEED }), "v0.7.15", [key.raw])).rejects.toThrow("not signed by Tau's release key");
    await expect(readRelease(fakeReleases({ [tagged]: FEED, [`${tagged}.sig`]: releaseKey().sign(FEED) }), "v0.7.15", [key.raw])).rejects.toThrow("not signed");
    const other = releaseUrl("v0.7.16", "latest-mac.yml");
    await expect(readRelease(fakeReleases({ [other]: FEED, [`${other}.sig`]: key.sign(FEED) }), "v0.7.16", [key.raw])).rejects.toThrow("latest-mac.yml of v0.7.16 is for 0.7.15");
    await expect(readRelease(vi.fn(async () => new Response("", { status: 500 })), "v0.7.15", [key.raw])).rejects.toThrow("answered 500");
  });

  it("keeps a download only when it matches the release's checksum", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-install-test-"));
    folders.push(dir);
    const url = releaseUrl("v0.7.15", "Tau-0.7.15-arm64.dmg");
    const target = join(dir, "Tau-0.7.15-arm64.dmg");
    await downloadChecked(fakeReleases({ [url]: DMG }), url, target, { sha512: SHA512, size: DMG.length });
    expect(readFileSync(target)).toEqual(DMG);
    const other = join(dir, "other.dmg");
    await expect(downloadChecked(fakeReleases({ [url]: Buffer.from("something else") }), url, other, { sha512: SHA512 })).rejects.toThrow("does not match");
    expect(existsSync(other)).toBe(false);
    expect(existsSync(`${other}.part`)).toBe(false);
  });
});
