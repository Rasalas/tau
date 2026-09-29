import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseReleaseInfo } from "../../bin/tau-update-helper.mjs";
import { collectFeeds, macArch, mergeMacFeeds, parseFeed, serializeFeed } from "./merge-feeds.mjs";

// What electron-builder wrote for v0.7.14, which built both Mac apps on one runner.
const COMBINED = readFileSync(new URL("./fixtures/latest-mac-v0.7.14.yml", import.meta.url), "utf8");

/** The feed one architecture's build writes on its own: its zip first, the zip in path and sha512. */
function singleArch(arch, releaseDate) {
  const { files } = parseFeed(COMBINED);
  const own = files.filter((entry) => macArch(entry[0][1]) === arch);
  return serializeFeed({
    top: [["version", "0.7.14"], ["files"], ["path", own[0][0][1]], ["sha512", own[0][1][1]], ["releaseDate", `'${releaseDate}'`]],
    files: own,
  });
}

const ARM64 = singleArch("arm64", "2026-09-29T19:31:02.100Z");
const X64 = singleArch("x64", "2026-09-29T19:38:15.002Z");

const folders = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("the Mac feed", () => {
  it("reads and writes a feed unchanged", () => {
    expect(serializeFeed(parseFeed(COMBINED))).toBe(COMBINED);
  });

  it("merges the two architectures into what a combined build writes", () => {
    expect(mergeMacFeeds([ARM64, X64])).toBe(COMBINED);
    expect(mergeMacFeeds([X64, ARM64])).toBe(COMBINED);
  });

  it("names the x64 zip as the default download and keeps every file's checksum and size", () => {
    const merged = mergeMacFeeds([ARM64, X64]);
    const info = parseReleaseInfo(merged);
    expect(info.version).toBe("0.7.14");
    expect(info.files.map((file) => file.url)).toEqual(["Tau-0.7.14-mac.zip", "Tau-0.7.14-arm64-mac.zip", "Tau-0.7.14.dmg", "Tau-0.7.14-arm64.dmg"]);
    expect(info.files.every((file) => file.sha512 && file.size > 0)).toBe(true);
    expect(merged).toMatch(/^path: Tau-0\.7\.14-mac\.zip$/mu);
    expect(merged).toContain(`sha512: ${info.files[0].sha512}\nreleaseDate`);
  });

  it("takes the later release date", () => {
    expect(mergeMacFeeds([X64, singleArch("arm64", "2026-09-30T01:00:00.000Z")])).toContain("releaseDate: '2026-09-30T01:00:00.000Z'");
  });

  it("refuses feeds that do not make a release of both architectures", () => {
    expect(() => mergeMacFeeds([ARM64])).toThrow(/no x64 \.zip/u);
    expect(() => mergeMacFeeds([ARM64, ARM64])).toThrow(/Two Mac feeds name/u);
    expect(() => mergeMacFeeds([ARM64, X64.replace("version: 0.7.14", "version: 0.7.15")])).toThrow(/different versions/u);
    expect(() => mergeMacFeeds([ARM64, `${X64}releaseNotes: |\n  multi\n`])).toThrow(/not a shape/u);
  });

  it("tells the architectures apart by electron-builder's names", () => {
    expect(["Tau-1.0.0-arm64.dmg", "Tau-1.0.0-arm64-mac.zip", "Tau-1.0.0.dmg", "Tau-1.0.0-mac.zip"].map(macArch)).toEqual(["arm64", "arm64", "x64", "x64"]);
  });
});

describe("collecting the feeds of a run", () => {
  it("merges the Mac feeds and copies the others once", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-feeds-"));
    folders.push(root);
    const put = (path, text) => { mkdirSync(join(root, "in", path, ".."), { recursive: true }); writeFileSync(join(root, "in", path), text); };
    put("feed-macos-arm64/latest-mac.yml", ARM64);
    put("feed-macos-x64/latest-mac.yml", X64);
    put("feed-linux/latest-linux.yml", "version: 0.7.14\n");
    put("feed-windows/latest.yml", "version: 0.7.14\r\n");
    expect(collectFeeds(join(root, "in"), join(root, "out"))).toEqual(["latest-linux.yml", "latest-mac.yml", "latest.yml"]);
    expect(readFileSync(join(root, "out", "latest-mac.yml"), "utf8")).toBe(COMBINED);
    expect(readFileSync(join(root, "out", "latest.yml"), "utf8")).toBe("version: 0.7.14\r\n");

    put("feed-other/latest.yml", "version: 0.7.13\n");
    expect(() => collectFeeds(join(root, "in"), join(root, "out2"))).toThrow(/different copies of latest\.yml/u);
  });
});
