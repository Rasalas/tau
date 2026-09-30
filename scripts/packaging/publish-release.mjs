// What the release workflow does on GitHub besides uploading: check that a
// release folder is complete, carry the notes over to the public repository,
// replace the nightly, and publish a draft only once every file arrived.
// The functions take the Octokit client actions/github-script hands in.
//
//   node scripts/packaging/publish-release.mjs check <folder> [--stable]
//   node scripts/packaging/publish-release.mjs copy-stable <folder>
import { copyFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseReleaseInfo } from "../../bin/tau-update-helper.mjs";
import { isMain, main } from "./release.mjs";

/** Where installed apps read releases from (`publish:` in tooling/electron-builder.yml). */
export const PUBLIC_REPO = { owner: "Rasalas", repo: "tau-releases" };

/** One feed per platform the release builds. */
export const FEEDS = ["latest-mac.yml", "latest.yml", "latest-linux.yml"];
/** Portable hosts advertised by this workflow, including ARM Linux SSH hosts. */
export const HOST_FEEDS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"].map((target) => `latest-host-${target}.yml`);

/** The AUR package installs it from the release, so every release carries it. */
export const LICENSE = "LICENSE";

/**
 * Names without a version, so `releases/latest/download/<name>` in tau-releases
 * always finds the newest stable installer (the website links them). Copies of
 * the versioned files; the feeds keep naming those.
 */
export const STABLE_NAMES = {
  "Tau-mac-arm64.dmg": (version) => `Tau-${version}-arm64.dmg`,
  "Tau-mac-x64.dmg": (version) => `Tau-${version}.dmg`,
  "Tau-windows-x64.exe": (version) => `Tau-Setup-${version}.exe`,
  "Tau-linux-amd64.deb": (version) => `Tau_${version}_amd64.deb`,
  "Tau-linux-x86_64.AppImage": (version) => `Tau-${version}.AppImage`,
  // For sideloading; no feed names it, Play and TestFlight update the phone apps.
  "Tau-android.apk": (version) => `Tau-${version}.apk`,
};

/** Each fixed name with the versioned file it copies. */
export function stableCopies(version) {
  return Object.entries(STABLE_NAMES).map(([name, source]) => ({ name, source: source(version) }));
}

/**
 * Why the files in a release folder do not make a release; empty when they do.
 * A stable release also needs the fixed names, each the size of its source;
 * a nightly must not carry them.
 */
export function releaseProblems(names, readText, { stable = false, sizeOf } = {}) {
  const have = new Set(names);
  const problems = [];
  const versions = new Set();
  const portableArchives = new Set();
  for (const feed of [...FEEDS, ...HOST_FEEDS]) {
    if (!have.has(feed)) {
      problems.push(`${feed} is missing.`);
      continue;
    }
    if (!have.has(`${feed}.sig`)) problems.push(`${feed}.sig is missing.`);
    const info = parseReleaseInfo(readText(feed));
    versions.add(info.version);
    if (HOST_FEEDS.includes(feed)) {
      const target = feed.slice("latest-host-".length, -".yml".length);
      const expected = `Tau-host-${info.version}-${target}.${target.startsWith("win32-") ? "zip" : "tar.gz"}`;
      if (info.files.length !== 1 || info.files[0].url !== expected) problems.push(`${feed} must name only ${expected}.`);
      else portableArchives.add(expected);
    }
    for (const file of info.files) {
      if (!have.has(file.url)) problems.push(`${feed} names ${file.url}, which is missing.`);
    }
  }
  // Differential downloads need them; the AppImage, the .deb and the fixed-name copies carry none.
  for (const name of names) {
    if (/\.(dmg|zip|exe)$/u.test(name) && !portableArchives.has(name) && !Object.hasOwn(STABLE_NAMES, name) && !have.has(`${name}.blockmap`)) problems.push(`${name}.blockmap is missing.`);
  }
  if (!have.has(LICENSE)) problems.push(`${LICENSE} is missing.`);
  if (!stable) {
    for (const name of names) if (Object.hasOwn(STABLE_NAMES, name)) problems.push(`${name} belongs to a stable release only.`);
    return problems;
  }
  const [version, ...others] = versions;
  if (!version || others.length > 0) {
    problems.push(`The feeds name ${[...versions].join(", ") || "no version"}; a stable release needs one.`);
    return problems;
  }
  for (const { name, source } of stableCopies(version)) {
    if (!have.has(source)) problems.push(`${source} is missing.`);
    if (!have.has(name)) problems.push(`${name} is missing.`);
    else if (sizeOf && have.has(source) && sizeOf(name) !== sizeOf(source)) problems.push(`${name} is not a copy of ${source}.`);
  }
  return problems;
}

/** Copies each versioned installer to its fixed name; returns the names written. */
export function copyStableNames(folder) {
  const version = parseReleaseInfo(readFileSync(join(folder, FEEDS[0]), "utf8")).version;
  if (!version) throw new Error(`${FEEDS[0]} in ${folder} names no version.`);
  return stableCopies(version).map(({ name, source }) => {
    copyFileSync(join(folder, source), join(folder, name));
    return name;
  });
}

export async function releaseBody(github, { owner, repo, releaseId }) {
  const { data } = await github.rest.repos.getRelease({ owner, repo, release_id: releaseId });
  return data.body ?? "";
}

/**
 * Deletes every release tagged `nightly`, a draft a failed run left too, and
 * the tag, so the next one points at its own commit and nothing stale stays.
 */
export async function removeNightly(github, { owner, repo }) {
  const releases = await github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 });
  const nightlies = releases.filter((release) => release.tag_name === "nightly");
  const stable = nightlies.find((release) => !release.prerelease && !release.draft);
  if (stable) throw new Error(`The release tagged nightly in ${owner}/${repo} is not a prerelease; refusing to delete it.`);
  for (const release of nightlies) await github.rest.repos.deleteRelease({ owner, repo, release_id: release.id });
  try {
    await github.rest.git.deleteRef({ owner, repo, ref: "tags/nightly" });
  } catch (error) {
    if (error.status !== 404 && error.status !== 422) throw error;
  }
}

/**
 * Publishes a draft once it carries every file in `names`. Until then an
 * installed Tau sees the previous release, never a feed whose files are
 * still uploading.
 */
export async function publishDraft(github, { owner, repo, releaseId, names, latest }) {
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, { owner, repo, release_id: releaseId, per_page: 100 });
  const uploaded = new Set(assets.filter((asset) => asset.state === "uploaded").map((asset) => asset.name));
  const missing = names.filter((name) => !uploaded.has(name));
  if (missing.length > 0) throw new Error(`The draft in ${owner}/${repo} lacks ${missing.join(", ")}; it stays a draft.`);
  const { data } = await github.rest.repos.updateRelease({ owner, repo, release_id: releaseId, draft: false, make_latest: latest ? "true" : "false" });
  return data.html_url;
}

/** The files a workflow step publishes from `folder`. */
export function releaseFiles(folder) {
  return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
}

if (isMain(import.meta.url)) {
  main(() => {
    const [command, folder, flag] = process.argv.slice(2);
    const usage = "usage: publish-release.mjs check <folder> [--stable] | copy-stable <folder>";
    if (!folder) throw new Error(usage);
    if (command === "copy-stable" && flag === undefined) {
      console.log(`Copied ${copyStableNames(folder).join(", ")}.`);
      return;
    }
    if (command !== "check" || (flag !== undefined && flag !== "--stable")) throw new Error(usage);
    const stable = flag === "--stable";
    const problems = releaseProblems(releaseFiles(folder), (name) => readFileSync(join(folder, name), "utf8"), {
      stable,
      sizeOf: (name) => statSync(join(folder, name)).size,
    });
    if (problems.length > 0) throw new Error(`${folder} is not a complete ${stable ? "stable " : ""}release:\n${problems.join("\n")}`);
    console.log(`${folder} holds a complete ${stable ? "stable " : ""}release.`);
  });
}
