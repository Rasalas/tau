#!/usr/bin/env node
// Whether main moved past the last nightly by anything the app ships; prints
// `changed=true` or `changed=false` for the release gate. A release's version
// bump, docs, tests and CI build the same app again.
//
//   node .github/scripts/nightly-changes.mjs <last nightly commit> <head commit>
import { execFileSync } from "node:child_process";
import { isMain, main } from "../../scripts/packaging/release.mjs";

/** The files a release bump touches (docs/RELEASE.md, "Cut a release"). */
export const VERSION_FILES = ["package.json", "package-lock.json", "kits/package.json"];

/** Files no build of the app reads. */
export function shipless(file) {
  return file.startsWith(".github/") || file.startsWith("docs/") || file.endsWith(".md") || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(file);
}

function withoutVersion(file, text) {
  const value = JSON.parse(text);
  delete value.version;
  if (file === "package-lock.json" && value.packages?.[""]) delete value.packages[""].version;
  return JSON.stringify(value);
}

/** `read(commit, file)` answers the file's text at that commit; a version file it cannot read counts as changed. */
export function appChanged(files, read, last, head) {
  return files.some((file) => {
    if (shipless(file)) return false;
    if (!VERSION_FILES.includes(file)) return true;
    try {
      return withoutVersion(file, read(last, file)) !== withoutVersion(file, read(head, file));
    } catch {
      return true;
    }
  });
}

if (isMain(import.meta.url)) {
  main(() => {
    const [last, head] = process.argv.slice(2);
    if (!last || !head) throw new Error("usage: nightly-changes.mjs <last nightly commit> <head commit>");
    const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const files = git("diff", "--name-only", last, head).split("\n").filter(Boolean);
    const read = (commit, file) => git("show", `${commit}:${file}`);
    console.log(`changed=${appChanged(files, read, last, head)}`);
  });
}
