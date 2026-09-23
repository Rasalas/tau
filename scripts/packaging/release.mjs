// What the package managers need from one GitHub release of Tau: the version,
// and for each installer its download URL and SHA-256. The release JSON comes
// from `gh api` (the repository may be private) or from a file (--release-json).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = "Rasalas/tau";
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The installers a release carries, by electron-builder's artifact names. */
const PATTERNS = {
  dmgArm64: /^Tau-(.+)-arm64\.dmg$/u,
  // `Tau-1.2.3-arm64.dmg` captures "1.2.3-arm64", which is not the version.
  dmgX64: /^Tau-(.+)\.dmg$/u,
  appImage: /^Tau-(.+)\.AppImage$/u,
  // "Tau.Setup.0.4.0.exe" up to 0.4.0, "Tau-Setup-0.4.1.exe" after the artifactName fix.
  exe: /^Tau[-.]Setup[-.](.+)\.exe$/u,
};

export function versionOfTag(tag) {
  const match = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/u.exec(tag);
  if (!match) throw new Error(`"${tag}" is not a release tag like v1.2.3.`);
  return match[1];
}

function sha256(asset) {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(asset.digest ?? "");
  if (!match) throw new Error(`${asset.name} has no SHA-256 digest in the release JSON. Download it and run \`shasum -a 256\` on it.`);
  return match[1];
}

/**
 * The installers of a release, each with its URL and SHA-256. A `.dmg` without
 * the arm64 suffix is the Intel one; blockmaps and zips are not installers.
 */
export function releaseAssets(release) {
  const version = versionOfTag(release.tag_name);
  const found = {};
  for (const asset of release.assets ?? []) {
    for (const [kind, pattern] of Object.entries(PATTERNS)) {
      const match = pattern.exec(asset.name);
      if (!match || match[1] !== version) continue;
      if (found[kind]) throw new Error(`${release.tag_name} has two assets for ${kind}: ${found[kind].name}, ${asset.name}`);
      found[kind] = { name: asset.name, url: asset.browser_download_url, sha256: sha256(asset) };
    }
  }
  for (const kind of Object.keys(PATTERNS)) {
    if (!found[kind]) throw new Error(`${release.tag_name} has no ${kind} asset for ${version}.`);
  }
  return {
    version,
    tag: release.tag_name,
    prerelease: Boolean(release.prerelease),
    publishedAt: release.published_at ?? "",
    notesUrl: release.html_url ?? `https://github.com/${REPO}/releases/tag/${release.tag_name}`,
    ...found,
  };
}

/** The parts of a release JSON the scripts read; what `packaging/release.json` keeps. */
export function trimRelease(release) {
  return {
    tag_name: release.tag_name,
    name: release.name,
    draft: release.draft,
    prerelease: release.prerelease,
    published_at: release.published_at,
    html_url: release.html_url,
    assets: (release.assets ?? []).map(({ name, size, digest, browser_download_url }) => ({ name, size, digest, browser_download_url })),
  };
}

export function packageVersion(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

export function parseArgs(argv) {
  const options = { tag: undefined, releaseJson: undefined, help: false };
  const value = (index, flag) => {
    if (!argv[index]) throw new Error(`${flag} needs a value`);
    return argv[index];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") options.tag = value(++index, arg);
    else if (arg === "--release-json") options.releaseJson = value(++index, arg);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown flag ${JSON.stringify(arg)} (known: --tag <v1.2.3>, --release-json <file>)`);
  }
  return options;
}

/** The release to package: a file when given, else `gh api` for the tag (default: package.json's version). */
export function loadRelease(options) {
  if (options.releaseJson) return JSON.parse(readFileSync(options.releaseJson, "utf8"));
  const tag = options.tag ?? `v${packageVersion()}`;
  return JSON.parse(execFileSync("gh", ["api", `repos/${REPO}/releases/tags/${tag}`], { encoding: "utf8" }));
}

/**
 * Runs one package's update from the command line: reads the release, hands
 * its assets to `update`, and writes the files it returns under the checkout.
 */
export function runUpdate(argv, usage, update) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage);
    return;
  }
  const release = loadRelease(options);
  const assets = releaseAssets(release);
  if (assets.prerelease) throw new Error(`${assets.tag} is a prerelease; the package managers carry stable releases only.`);
  for (const [path, text] of Object.entries(update(assets, release))) {
    writeFileSync(join(ROOT, path), text);
    console.log(`wrote ${path} for ${assets.version}`);
  }
}

export function isMain(url) {
  return Boolean(process.argv[1]) && url === pathToFileURL(process.argv[1]).href;
}

export function main(run) {
  try { run(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
