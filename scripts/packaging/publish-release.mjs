// What the release workflow does on GitHub besides uploading: check that a
// release folder is complete, carry the notes over to the public repository,
// replace the nightly, and publish a draft only once every file arrived.
// The functions take the Octokit client actions/github-script hands in.
//
//   node scripts/packaging/publish-release.mjs check <folder>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReleaseInfo } from "../../bin/tau-update-helper.mjs";
import { isMain, main } from "./release.mjs";

/** Where installed apps read releases from (`publish:` in electron-builder.yml). */
export const PUBLIC_REPO = { owner: "Rasalas", repo: "tau-releases" };

/** One feed per platform the release builds. */
export const FEEDS = ["latest-mac.yml", "latest.yml", "latest-linux.yml"];

/** The AUR package installs it from the release; the source repository is not public. */
export const LICENSE = "LICENSE";

/** Why the files in a release folder do not make a release; empty when they do. */
export function releaseProblems(names, readText) {
  const have = new Set(names);
  const problems = [];
  for (const feed of FEEDS) {
    if (!have.has(feed)) {
      problems.push(`${feed} is missing.`);
      continue;
    }
    if (!have.has(`${feed}.sig`)) problems.push(`${feed}.sig is missing.`);
    for (const file of parseReleaseInfo(readText(feed)).files) {
      if (!have.has(file.url)) problems.push(`${feed} names ${file.url}, which is missing.`);
    }
  }
  // Differential downloads need them; the AppImage and the .deb carry none.
  for (const name of names) {
    if (/\.(dmg|zip|exe)$/u.test(name) && !have.has(`${name}.blockmap`)) problems.push(`${name}.blockmap is missing.`);
  }
  if (!have.has(LICENSE)) problems.push(`${LICENSE} is missing.`);
  return problems;
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
    const [command, folder] = process.argv.slice(2);
    if (command !== "check" || !folder) throw new Error("usage: publish-release.mjs check <folder>");
    const problems = releaseProblems(releaseFiles(folder), (name) => readFileSync(join(folder, name), "utf8"));
    if (problems.length > 0) throw new Error(`${folder} is not a complete release:\n${problems.join("\n")}`);
    console.log(`${folder} holds a complete release.`);
  });
}
