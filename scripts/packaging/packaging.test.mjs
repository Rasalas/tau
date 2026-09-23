import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNightlyVersion } from "../../src/shared/app-version.js";
import { nightlyVersion, parseArgs as parseNightlyArgs } from "./nightly-version.mjs";
import { ROOT, parseArgs, releaseAssets, versionOfTag } from "./release.mjs";
import { AUR_DIR } from "./update-aur.mjs";
import { renderCask } from "./update-cask.mjs";
import { RELEASE_PATH, renderPackages } from "./update-packages.mjs";
import { renderWingetManifests } from "./update-winget.mjs";

/** v0.4.0 as `gh api repos/Rasalas/tau/releases/tags/v0.4.0` returned it, trimmed to what the scripts read. */
const RELEASE = JSON.parse(readFileSync(new URL("./fixtures/release-v0.4.0.json", import.meta.url), "utf8"));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

/** A later release with the installer name the artifactName fix gives it. */
function nextRelease() {
  const hash = (char) => char.repeat(64);
  const asset = (name, char) => ({ name, digest: `sha256:${hash(char)}`, browser_download_url: `https://github.com/Rasalas/tau/releases/download/v0.4.1/${name}` });
  return {
    tag_name: "v0.4.1",
    prerelease: false,
    published_at: "2026-10-01T10:00:00Z",
    html_url: "https://github.com/Rasalas/tau/releases/tag/v0.4.1",
    assets: [
      asset("Tau-0.4.1-arm64.dmg", "a"), asset("Tau-0.4.1-arm64.dmg.blockmap", "0"), asset("Tau-0.4.1.dmg", "b"),
      asset("Tau-0.4.1.AppImage", "c"), asset("Tau-Setup-0.4.1.exe", "d"), asset("latest-mac.yml", "e"),
    ],
  };
}

describe("release assets", () => {
  it("finds each installer of a real release with its digest", () => {
    const assets = releaseAssets(RELEASE);
    expect(assets.version).toBe("0.4.0");
    expect(assets.dmgArm64).toEqual({
      name: "Tau-0.4.0-arm64.dmg",
      url: "https://github.com/Rasalas/tau/releases/download/v0.4.0/Tau-0.4.0-arm64.dmg",
      sha256: "1b8b5745e9dfcc86ce5d1093607487c027ec6412b32601a5d80b54448d528266",
    });
    expect(assets.dmgX64.name).toBe("Tau-0.4.0.dmg");
    expect(assets.appImage.sha256).toBe("575d2258af61696957684356fd7e9be57bce37bb36c34311596b6a98ab385aaa");
    // GitHub stored "Tau Setup 0.4.0.exe" with dots.
    expect(assets.exe.name).toBe("Tau.Setup.0.4.0.exe");
    expect(releaseAssets(nextRelease()).exe.name).toBe("Tau-Setup-0.4.1.exe");
  });

  it("refuses a release that lacks an installer or a digest", () => {
    const withoutAppImage = { ...RELEASE, assets: RELEASE.assets.filter((asset) => !asset.name.endsWith(".AppImage")) };
    expect(() => releaseAssets(withoutAppImage)).toThrow("has no appImage asset for 0.4.0");
    const withoutDigest = { ...RELEASE, assets: RELEASE.assets.map((asset) => (asset.name === "Tau-0.4.0.dmg" ? { ...asset, digest: null } : asset)) };
    expect(() => releaseAssets(withoutDigest)).toThrow("Tau-0.4.0.dmg has no SHA-256 digest");
    expect(() => versionOfTag("nightly")).toThrow("not a release tag");
  });

  it("parses the command line the three scripts share", () => {
    expect(parseArgs(["--tag", "v0.4.0"])).toEqual({ tag: "v0.4.0", releaseJson: undefined, help: false });
    expect(() => parseArgs(["--tag"])).toThrow("--tag needs a value");
    expect(() => parseArgs(["--publish"])).toThrow("unknown flag");
  });
});

describe("the committed packaging files", () => {
  it("are what `npm run packaging:update` writes for the release they record", () => {
    const release = JSON.parse(read(RELEASE_PATH));
    const files = renderPackages(releaseAssets(release), release);
    expect(Object.keys(files)).toHaveLength(7);
    for (const [path, text] of Object.entries(files)) expect(read(path), path).toBe(text);
  });
});

describe("the Homebrew cask", () => {
  it("carries the version and both image hashes, with the version left to the URL", () => {
    const cask = renderCask(releaseAssets(nextRelease()));
    expect(cask).toContain('version "0.4.1"');
    expect(cask).toContain(`sha256 "${"a".repeat(64)}"`);
    expect(cask).toContain(`sha256 "${"b".repeat(64)}"`);
    expect(cask).toContain('url "https://github.com/Rasalas/tau/releases/download/v#{version}/Tau-#{version}-arm64.dmg"');
    expect(cask).toContain('url "https://github.com/Rasalas/tau/releases/download/v#{version}/Tau-#{version}.dmg"');
  });
});

describe("the winget manifests", () => {
  it("name one version across the triple and an upper-case installer hash", () => {
    const manifests = renderWingetManifests(releaseAssets(nextRelease()));
    expect(Object.keys(manifests)).toEqual(["Rasalas.Tau.yaml", "Rasalas.Tau.installer.yaml", "Rasalas.Tau.locale.en-US.yaml"]);
    for (const text of Object.values(manifests)) {
      expect(text).toContain("PackageIdentifier: Rasalas.Tau\nPackageVersion: 0.4.1\n");
      expect(text).toContain("ManifestVersion: 1.9.0\n");
    }
    const installer = manifests["Rasalas.Tau.installer.yaml"];
    expect(installer).toContain("InstallerUrl: https://github.com/Rasalas/tau/releases/download/v0.4.1/Tau-Setup-0.4.1.exe");
    expect(installer).toContain(`InstallerSha256: ${"D".repeat(64)}`);
    expect(installer).toContain("ReleaseDate: 2026-10-01");
  });
});

describe("the AUR package", () => {
  it("describes the same sources and hashes in the PKGBUILD as in .SRCINFO", () => {
    // What makepkg would read: the PKGBUILD evaluated by bash.
    const script = `source "$1"; printf '%s\\n' "$pkgver" "\${source[@]}" "\${sha256sums[@]}" "\${depends[@]}" "\${conflicts[@]}"`;
    const evaluated = execFileSync("bash", ["-c", script, "bash", join(ROOT, AUR_DIR, "PKGBUILD")], { encoding: "utf8" }).trim().split("\n");
    const srcinfo = read(`${AUR_DIR}/.SRCINFO`);
    const field = (name) => [...srcinfo.matchAll(new RegExp(`^\\t${name} = (.+)$`, "gmu"))].map((match) => match[1]);
    expect(evaluated).toEqual([...field("pkgver"), ...field("source"), ...field("sha256sums"), ...field("depends"), ...field("conflicts")]);
  });
});

describe("the nightly version", () => {
  it("follows the release it builds on and sorts by day and run", () => {
    const version = nightlyVersion("0.4.0", new Date("2026-09-22T03:17:00Z"), 42);
    expect(version).toBe("0.4.1-nightly.20260922.42");
    expect(isNightlyVersion(version)).toBe(true);
    expect(() => nightlyVersion("0.4.1-nightly.20260922.1", new Date(), 1)).toThrow("not a plain release version");
    expect(() => nightlyVersion("0.4.0", new Date(), 0)).toThrow("positive integer");
  });

  it("reads its flags", () => {
    const options = parseNightlyArgs(["--run", "7", "--date", "2026-09-22"]);
    expect(options.run).toBe(7);
    expect(options.date.toISOString()).toBe("2026-09-22T00:00:00.000Z");
    expect(() => parseNightlyArgs([])).toThrow("--run <n> is required");
    expect(() => parseNightlyArgs(["--date", "tomorrow", "--run", "1"])).toThrow("YYYY-MM-DD");
  });
});
