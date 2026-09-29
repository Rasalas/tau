import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isNightlyVersion } from "../../src/shared/app-version.js";
import { foreignMachOFiles, machOArchitectures, macPackagesFor } from "./mac-architectures.mjs";
import { nightlyVersion, parseArgs as parseNightlyArgs } from "./nightly-version.mjs";
import { STABLE_NAMES } from "./publish-release.mjs";
import { ROOT, loadRelease, parseArgs, releaseAssets, versionOfTag } from "./release.mjs";
import { AUR_DIR, renderPkgbuild, renderSrcinfo } from "./update-aur.mjs";
import { renderCask } from "./update-cask.mjs";
import { RELEASE_PATH, renderPackages } from "./update-packages.mjs";
import { renderWingetManifests } from "./update-winget.mjs";

/** v0.4.0 as `gh api repos/Rasalas/tau/releases/tags/v0.4.0` returned it, trimmed to what the scripts read. */
const RELEASE = JSON.parse(readFileSync(new URL("./fixtures/release-v0.4.0.json", import.meta.url), "utf8"));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

/** A later release as the public release repository carries it, with the installer name the artifactName fix gives it. */
function nextRelease() {
  const hash = (char) => char.repeat(64);
  const asset = (name, char) => ({ name, digest: `sha256:${hash(char)}`, browser_download_url: `https://github.com/Rasalas/tau-releases/releases/download/v0.4.1/${name}` });
  return {
    tag_name: "v0.4.1",
    prerelease: false,
    published_at: "2026-10-01T10:00:00Z",
    html_url: "https://github.com/Rasalas/tau-releases/releases/tag/v0.4.1",
    assets: [
      asset("Tau-0.4.1-arm64.dmg", "a"), asset("Tau-0.4.1-arm64.dmg.blockmap", "0"), asset("Tau-0.4.1.dmg", "b"),
      asset("Tau-0.4.1.AppImage", "c"), asset("Tau-Setup-0.4.1.exe", "d"), asset("latest-mac.yml", "e"), asset("LICENSE", "f"),
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

  it("leaves the fixed-name copies to the website", () => {
    const release = nextRelease();
    const copies = Object.keys(STABLE_NAMES).map((name) => ({ ...release.assets[0], name }));
    expect(releaseAssets({ ...release, assets: [...release.assets, ...copies] })).toEqual(releaseAssets(release));
  });

  it("refuses a release that lacks an installer or a digest", () => {
    const withoutAppImage = { ...RELEASE, assets: RELEASE.assets.filter((asset) => !asset.name.endsWith(".AppImage")) };
    expect(() => releaseAssets(withoutAppImage)).toThrow("has no appImage asset for 0.4.0");
    const withoutDigest = { ...RELEASE, assets: RELEASE.assets.map((asset) => (asset.name === "Tau-0.4.0.dmg" ? { ...asset, digest: null } : asset)) };
    expect(() => releaseAssets(withoutDigest)).toThrow("Tau-0.4.0.dmg has no SHA-256 digest");
    expect(() => versionOfTag("nightly")).toThrow("not a release tag");
  });

  it("reads a release from the public repository without a login", async () => {
    const fetchUrl = vi.fn(async () => new Response(JSON.stringify(nextRelease())));
    expect((await loadRelease({ tag: "v0.4.1" }, fetchUrl)).tag_name).toBe("v0.4.1");
    expect(fetchUrl).toHaveBeenCalledWith("https://api.github.com/repos/Rasalas/tau-releases/releases/tags/v0.4.1", { headers: { accept: "application/vnd.github+json" } });
    await expect(loadRelease({ tag: "v0.4.0" }, vi.fn(async () => new Response("{}", { status: 404 })))).rejects.toThrow("is v0.4.0 published in Rasalas/tau-releases?");
  });

  it("knows the repository a release lives in", () => {
    expect(releaseAssets(RELEASE).repoUrl).toBe("https://github.com/Rasalas/tau");
    expect(releaseAssets(nextRelease()).repoUrl).toBe("https://github.com/Rasalas/tau-releases");
    expect(releaseAssets(nextRelease()).license).toEqual({ name: "LICENSE", url: "https://github.com/Rasalas/tau-releases/releases/download/v0.4.1/LICENSE" });
    expect(releaseAssets(RELEASE).license).toBeUndefined();
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
    expect(cask).toContain('url "https://github.com/Rasalas/tau-releases/releases/download/v#{version}/Tau-#{version}-arm64.dmg"');
    expect(cask).toContain('url "https://github.com/Rasalas/tau-releases/releases/download/v#{version}/Tau-#{version}.dmg"');
    expect(cask).toContain('homepage "https://github.com/Rasalas/tau-releases"');
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
    expect(installer).toContain("InstallerUrl: https://github.com/Rasalas/tau-releases/releases/download/v0.4.1/Tau-Setup-0.4.1.exe");
    const locale = manifests["Rasalas.Tau.locale.en-US.yaml"];
    expect(locale).toContain("PackageUrl: https://github.com/Rasalas/tau-releases\n");
    expect(locale).toContain("LicenseUrl: https://github.com/Rasalas/tau-releases/releases/download/v0.4.1/LICENSE\n");
    expect(locale).toContain("ReleaseNotesUrl: https://github.com/Rasalas/tau-releases/releases/tag/v0.4.1\n");
    expect(installer).toContain(`InstallerSha256: ${"D".repeat(64)}`);
    expect(installer).toContain("ReleaseDate: 2026-10-01");
  });
});

describe("the AUR package", () => {
  it("downloads the AppImage and the license from the public release", () => {
    const assets = releaseAssets(nextRelease());
    const pkgbuild = renderPkgbuild(assets, "f".repeat(64));
    expect(pkgbuild).toContain("url='https://github.com/Rasalas/tau-releases'");
    expect(pkgbuild).toContain('"${_appimage}::https://github.com/Rasalas/tau-releases/releases/download/v${_version}/${_appimage}"');
    expect(pkgbuild).toContain('"LICENSE-${_version}::https://github.com/Rasalas/tau-releases/releases/download/v${_version}/LICENSE"');
    expect(renderSrcinfo(assets, "f".repeat(64))).toContain("\tsource = LICENSE-0.4.1::https://github.com/Rasalas/tau-releases/releases/download/v0.4.1/LICENSE\n");
  });

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

describe("each Mac app's architecture", () => {
  const lock = JSON.parse(read("package-lock.json"));
  // The matcher electron-builder applies to `files`, with the macros expanded as it does.
  const { Minimatch } = createRequire(createRequire(import.meta.url).resolve("app-builder-lib"))("minimatch");
  const patterns = [...read("electron-builder.yml").matchAll(/^ {2}- "(!\*\*\/node_modules\/[^"]*)"$/gmu)].map((match) => match[1]);
  const shipped = (path, platform, arch) =>
    patterns.every((pattern) => new Minimatch(pattern.replaceAll("${platform}", platform).replaceAll("${arch}", arch), { dot: true }).match(path));

  it("comes from the lockfile's production packages built for exactly one macOS architecture", () => {
    const fixture = {
      packages: {
        "": { name: "tau" },
        "node_modules/@esbuild/darwin-x64": { version: "0.25.12", integrity: "sha512-a", os: ["darwin"], cpu: ["x64"], optional: true },
        "node_modules/pi/node_modules/@esbuild/darwin-x64": { version: "0.28.1", integrity: "sha512-b", os: ["darwin"], cpu: ["x64"], optional: true },
        "node_modules/@esbuild/darwin-arm64": { version: "0.25.12", os: ["darwin"], cpu: ["arm64"], optional: true },
        "node_modules/@esbuild/linux-x64": { version: "0.25.12", os: ["linux"], cpu: ["x64"], optional: true },
        "node_modules/@x/tool-darwin-universal": { version: "1.0.0", os: ["darwin"], optional: true },
        "node_modules/@rollup/rollup-darwin-x64": { version: "4.0.0", os: ["darwin"], cpu: ["x64"], dev: true, optional: true },
        "node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64": { version: "0.3.0", os: ["darwin"], cpu: ["x64"], optional: true },
      },
    };
    expect(macPackagesFor(fixture, "x64")).toEqual([
      { path: "node_modules/@esbuild/darwin-x64", name: "@esbuild/darwin-x64", version: "0.25.12", integrity: "sha512-a" },
      { path: "node_modules/pi/node_modules/@esbuild/darwin-x64", name: "@esbuild/darwin-x64", version: "0.28.1", integrity: "sha512-b" },
    ]);
    expect(macPackagesFor(lock, "x64").map((pkg) => pkg.name)).toContain("@esbuild/darwin-x64");
  });

  it("keeps a platform package out of the other architecture's app", () => {
    for (const [arch, other] of [["x64", "arm64"], ["arm64", "x64"]]) {
      for (const pkg of macPackagesFor(lock, arch)) {
        expect(shipped(`${pkg.path}/package.json`, "darwin", arch), `${pkg.path} in the ${arch} app`).toBe(true);
        expect(shipped(pkg.path, "darwin", other), `${pkg.path} in the ${other} app`).toBe(false);
        expect(shipped(`${pkg.path}/package.json`, "darwin", other), `${pkg.path} in the ${other} app`).toBe(false);
      }
    }
    expect(shipped("node_modules/@mariozechner/clipboard-darwin-universal/package.json", "darwin", "x64")).toBe(true);
  });

  it("keeps only the prebuilds for the app's own platform and architecture", () => {
    const prebuilt = (dir) => `node_modules/node-pty/prebuilds/${dir}/pty.node`;
    expect(shipped(prebuilt("darwin-x64"), "darwin", "x64")).toBe(true);
    expect(shipped(prebuilt("darwin-arm64"), "darwin", "x64")).toBe(false);
    expect(shipped(prebuilt("darwin-arm64"), "darwin", "arm64")).toBe(true);
    expect(shipped(prebuilt("darwin-x64"), "darwin", "arm64")).toBe(false);
    expect(shipped(prebuilt("win32-x64"), "darwin", "x64")).toBe(false);
    expect(shipped(prebuilt("win32-x64"), "win32", "x64")).toBe(true);
    expect(shipped(prebuilt("darwin-x64+arm64"), "darwin", "arm64")).toBe(true);
    expect(shipped("node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-x64/darwin-modifiers.node", "darwin", "arm64")).toBe(false);
    expect(shipped("node_modules/@earendil-works/pi-tui/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node", "darwin", "arm64")).toBe(true);
  });
});

describe("the native file check", () => {
  const thin = (magic, cpu) => {
    const header = Buffer.alloc(32);
    header.writeUInt32LE(magic, 0);
    header.writeUInt32LE(cpu, 4);
    return header;
  };
  const fat = (...cpus) => {
    const header = Buffer.alloc(8 + cpus.length * 20);
    header.writeUInt32BE(0xcafebabe, 0);
    header.writeUInt32BE(cpus.length, 4);
    cpus.forEach((cpu, index) => header.writeUInt32BE(cpu, 8 + index * 20));
    return header;
  };
  const X64 = 0x0100_0007;
  const ARM64 = 0x0100_000c;

  it("reads the architectures of thin and universal Mach-O files", () => {
    expect(machOArchitectures(thin(0xfeedfacf, X64))).toEqual(["x64"]);
    expect(machOArchitectures(thin(0xfeedfacf, ARM64))).toEqual(["arm64"]);
    expect(machOArchitectures(fat(X64, ARM64))).toEqual(["x64", "arm64"]);
  });

  it("does not take a Java class file or text for a Mach-O file", () => {
    const javaClass = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]);
    expect(machOArchitectures(javaClass)).toBeUndefined();
    expect(machOArchitectures(Buffer.from("#!/bin/sh\necho hi\n"))).toBeUndefined();
  });

  it("lists the files an app's architecture cannot run", async () => {
    const app = await mkdtemp(join(tmpdir(), "tau-arch-"));
    const put = async (path, content) => {
      await mkdir(join(app, path, ".."), { recursive: true });
      await writeFile(join(app, path), content);
    };
    await put("prebuilds/darwin-arm64/pty.node", thin(0xfeedfacf, ARM64));
    await put("prebuilds/darwin-x64/pty.node", thin(0xfeedfacf, X64));
    await put("bin/universal", fat(X64, ARM64));
    await put("lib/main.js", "module.exports = 1;");
    expect(foreignMachOFiles(app, "x64")).toEqual([{ file: join("prebuilds", "darwin-arm64", "pty.node"), architectures: ["arm64"] }]);
    expect(foreignMachOFiles(app, "arm64")).toEqual([{ file: join("prebuilds", "darwin-x64", "pty.node"), architectures: ["x64"] }]);
  });
});
