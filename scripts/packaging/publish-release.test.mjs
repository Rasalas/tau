import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STABLE_NAMES, publishDraft, releaseBody, releaseProblems, removeNightly, stableCopies } from "./publish-release.mjs";

const SCRIPT = new URL("./publish-release.mjs", import.meta.url).pathname;
const feed = (...urls) => `version: 0.7.15\nfiles:\n${urls.map((url) => `  - url: ${url}\n    sha512: x==\n    size: 1\n`).join("")}path: ${urls[0]}\n`;
const FEEDS = {
  "latest-mac.yml": feed("Tau-0.7.15-arm64-mac.zip", "Tau-0.7.15-arm64.dmg", "Tau-0.7.15-mac.zip", "Tau-0.7.15.dmg"),
  "latest.yml": feed("Tau-Setup-0.7.15.exe"),
  "latest-linux.yml": feed("Tau-0.7.15.AppImage", "Tau_0.7.15_amd64.deb"),
};
const INSTALLERS = ["Tau-0.7.15-arm64-mac.zip", "Tau-0.7.15-arm64.dmg", "Tau-0.7.15-mac.zip", "Tau-0.7.15.dmg", "Tau-Setup-0.7.15.exe"];
const COMPLETE = [
  ...Object.keys(FEEDS), ...Object.keys(FEEDS).map((name) => `${name}.sig`),
  ...INSTALLERS, ...INSTALLERS.map((name) => `${name}.blockmap`),
  "Tau-0.7.15.AppImage", "Tau_0.7.15_amd64.deb", "LICENSE",
];
const read = (name) => FEEDS[name];
const STABLE = ["Tau-mac-arm64.dmg", "Tau-mac-x64.dmg", "Tau-windows-x64.exe", "Tau-linux-amd64.deb", "Tau-linux-x86_64.AppImage", "Tau-android.apk"];
// The Android build's APK: a stable release carries it, no feed names it.
const APK = "Tau-0.7.15.apk";

const folders = [];
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Octokit as github-script hands it in, with the calls it saw. */
function fakeGithub({ releases = [], assets = [], tagMissing = false } = {}) {
  const calls = [];
  const rest = {
    repos: {
      getRelease: vi.fn(async (args) => { calls.push(["getRelease", args]); return { data: { body: "## What's Changed\n* one" } }; }),
      listReleases: vi.fn(),
      deleteRelease: vi.fn(async (args) => { calls.push(["deleteRelease", args]); }),
      listReleaseAssets: vi.fn(),
      updateRelease: vi.fn(async (args) => { calls.push(["updateRelease", args]); return { data: { html_url: "https://github.com/Rasalas/tau-releases/releases/tag/v0.7.15" } }; }),
    },
    git: { deleteRef: vi.fn(async (args) => { calls.push(["deleteRef", args]); if (tagMissing) throw Object.assign(new Error("Reference does not exist"), { status: 422 }); }) },
  };
  const paginate = vi.fn(async (method) => method === rest.repos.listReleases ? releases : assets);
  return { calls, github: { rest, paginate } };
}

const REPO = { owner: "Rasalas", repo: "tau-releases" };

describe("a release folder", () => {
  it("is complete with every feed, its signature, the files it names, their blockmaps and the license", () => {
    expect(releaseProblems(COMPLETE, read)).toEqual([]);
  });

  it("says what is missing", () => {
    const without = (...names) => COMPLETE.filter((name) => !names.includes(name));
    expect(releaseProblems(without("latest.yml.sig"), read)).toEqual(["latest.yml.sig is missing."]);
    expect(releaseProblems(without("latest-mac.yml", "latest-mac.yml.sig"), read)).toEqual(["latest-mac.yml is missing."]);
    expect(releaseProblems(without("Tau_0.7.15_amd64.deb"), read)).toEqual(["latest-linux.yml names Tau_0.7.15_amd64.deb, which is missing."]);
    expect(releaseProblems(without("Tau-0.7.15.dmg.blockmap"), read)).toEqual(["Tau-0.7.15.dmg.blockmap is missing."]);
    expect(releaseProblems(without("LICENSE"), read)).toEqual(["LICENSE is missing."]);
  });

  it("is checked from the command line", () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-publish-release-"));
    folders.push(dir);
    for (const name of COMPLETE) writeFileSync(join(dir, name), FEEDS[name] ?? "x");
    expect(spawnSync(process.execPath, [SCRIPT, "check", dir], { encoding: "utf8" }).status).toBe(0);
    rmSync(join(dir, "latest-linux.yml.sig"));
    const failed = spawnSync(process.execPath, [SCRIPT, "check", dir], { encoding: "utf8" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("latest-linux.yml.sig is missing.");
  });
});

describe("the fixed download names", () => {
  // The website and the README link these under releases/latest/download/.
  it("copy one installer each, by the names the links use", () => {
    expect(Object.keys(STABLE_NAMES)).toEqual(STABLE);
    expect(stableCopies("0.7.15")).toEqual([
      { name: "Tau-mac-arm64.dmg", source: "Tau-0.7.15-arm64.dmg" },
      { name: "Tau-mac-x64.dmg", source: "Tau-0.7.15.dmg" },
      { name: "Tau-windows-x64.exe", source: "Tau-Setup-0.7.15.exe" },
      { name: "Tau-linux-amd64.deb", source: "Tau_0.7.15_amd64.deb" },
      { name: "Tau-linux-x86_64.AppImage", source: "Tau-0.7.15.AppImage" },
      { name: "Tau-android.apk", source: APK },
    ]);
    const named = Object.values(FEEDS).flatMap((text) => [...text.matchAll(/url: (\S+)/gu)].map((match) => match[1]));
    for (const { source } of stableCopies("0.7.15")) if (source !== APK) expect(named).toContain(source);
  });

  it("are required in a stable release, without blockmaps, and each the size of its source", () => {
    const size = (name) => (name.includes("arm64") ? 2 : 1);
    expect(releaseProblems([...COMPLETE, APK, ...STABLE], read, { stable: true, sizeOf: size })).toEqual([]);
    expect(releaseProblems([...COMPLETE, APK], read, { stable: true })).toEqual(STABLE.map((name) => `${name} is missing.`));
    const wrong = (name) => (name === "Tau-mac-x64.dmg" ? 2 : size(name));
    expect(releaseProblems([...COMPLETE, APK, ...STABLE], read, { stable: true, sizeOf: wrong })).toEqual(["Tau-mac-x64.dmg is not a copy of Tau-0.7.15.dmg."]);
  });

  it("need the Android APK in a stable release, and let a nightly go without it", () => {
    expect(releaseProblems([...COMPLETE, ...STABLE.filter((name) => name !== "Tau-android.apk")], read, { stable: true })).toEqual([`${APK} is missing.`, "Tau-android.apk is missing."]);
    expect(releaseProblems(COMPLETE, read)).toEqual([]);
  });

  it("stay out of a nightly", () => {
    expect(releaseProblems([...COMPLETE, "Tau-mac-arm64.dmg"], read)).toEqual(["Tau-mac-arm64.dmg belongs to a stable release only."]);
  });

  it("need one version across the feeds", () => {
    const mixed = (name) => (name === "latest.yml" ? FEEDS[name].replace("0.7.15", "0.7.16") : FEEDS[name]);
    expect(releaseProblems([...COMPLETE, APK, ...STABLE], mixed, { stable: true })).toEqual(["The feeds name 0.7.15, 0.7.16; a stable release needs one."]);
  });

  it("are written and checked from the command line", () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-publish-release-"));
    folders.push(dir);
    for (const name of [...COMPLETE, APK]) writeFileSync(join(dir, name), FEEDS[name] ?? `contents of ${name}`);
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
    expect(run("check", dir, "--stable").stderr).toContain("Tau-mac-arm64.dmg is missing.");
    expect(run("copy-stable", dir).status).toBe(0);
    for (const { name, source } of stableCopies("0.7.15")) expect(readFileSync(join(dir, name), "utf8")).toBe(`contents of ${source}`);
    expect(run("check", dir, "--stable").status).toBe(0);
    expect(run("check", dir).stderr).toContain("belongs to a stable release only.");
    rmSync(join(dir, "Tau-linux-amd64.deb"));
    expect(existsSync(join(dir, "Tau_0.7.15_amd64.deb"))).toBe(true);
    expect(run("check", dir, "--stable").stderr).toContain("Tau-linux-amd64.deb is missing.");
  });
});

describe("publishing on GitHub", () => {
  it("takes the notes of the source repository's release", async () => {
    const { github } = fakeGithub();
    expect(await releaseBody(github, { owner: "Rasalas", repo: "tau", releaseId: 7 })).toBe("## What's Changed\n* one");
    expect(github.rest.repos.getRelease).toHaveBeenCalledWith({ owner: "Rasalas", repo: "tau", release_id: 7 });
  });

  it("publishes a draft only once every file is uploaded", async () => {
    const names = ["latest-linux.yml", "latest-linux.yml.sig", "Tau_0.7.15_amd64.deb"];
    const partial = fakeGithub({ assets: [{ name: "latest-linux.yml", state: "uploaded" }, { name: "latest-linux.yml.sig", state: "uploaded" }, { name: "Tau_0.7.15_amd64.deb", state: "starter" }] });
    await expect(publishDraft(partial.github, { ...REPO, releaseId: 3, names, latest: true })).rejects.toThrow("lacks Tau_0.7.15_amd64.deb; it stays a draft");
    expect(partial.github.rest.repos.updateRelease).not.toHaveBeenCalled();

    const done = fakeGithub({ assets: names.map((name) => ({ name, state: "uploaded" })) });
    await publishDraft(done.github, { ...REPO, releaseId: 3, names, latest: true });
    expect(done.github.rest.repos.updateRelease).toHaveBeenCalledWith({ ...REPO, release_id: 3, draft: false, make_latest: "true" });
    await publishDraft(done.github, { ...REPO, releaseId: 4, names, latest: false });
    expect(done.github.rest.repos.updateRelease).toHaveBeenLastCalledWith({ ...REPO, release_id: 4, draft: false, make_latest: "false" });
  });

  it("removes the previous nightly, a draft left behind and the tag, and nothing that is not a prerelease", async () => {
    const releases = [{ id: 9, tag_name: "nightly", prerelease: true, draft: false }, { id: 10, tag_name: "nightly", prerelease: true, draft: true }, { id: 2, tag_name: "v0.7.14", prerelease: false, draft: false }];
    const nightly = fakeGithub({ releases });
    await removeNightly(nightly.github, REPO);
    expect(nightly.calls).toEqual([["deleteRelease", { ...REPO, release_id: 9 }], ["deleteRelease", { ...REPO, release_id: 10 }], ["deleteRef", { ...REPO, ref: "tags/nightly" }]]);

    const first = fakeGithub({ tagMissing: true });
    await expect(removeNightly(first.github, REPO)).resolves.toBeUndefined();

    const stable = fakeGithub({ releases: [{ id: 1, tag_name: "nightly", prerelease: false, draft: false }] });
    await expect(removeNightly(stable.github, REPO)).rejects.toThrow("not a prerelease");
    expect(stable.github.rest.repos.deleteRelease).not.toHaveBeenCalled();
    expect(stable.github.rest.git.deleteRef).not.toHaveBeenCalled();
  });
});
