#!/usr/bin/env node
// A fixture project for remote-work tests: a bare "origin" and a checkout of
// it under .tau-dev/remote-work/<name>/, both local. The checkout's origin is a
// file:// URL, which Tau clones only with TAU_TEST_CLONE_ROOT pointing here.
// Nothing is ever pushed anywhere; the bare repo is made with `clone --bare`.
//
//   node scripts/remote-work-fixture.mjs [--name <name>] [--fresh] [--clean]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { remoteWorkDir } from "./tau-test-host.mjs";

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u;
// Fixed identity and dates: the same fixture has the same commit ids on every machine.
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Tau Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Tau Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};
// Never the caller's hooks, templates or signing.
const GIT_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.defaultBranch=main"];
// Eight bytes of a PNG header and a NUL: Git treats the file as binary.
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x10, 0x20]);

function git(cwd, args, env = {}) {
  return execFileSync("git", [...GIT_CONFIG, ...args], { cwd, env: { ...process.env, ...GIT_ENV, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** Where fixture `name` lives below `root`; refuses names that could leave it. */
export function fixturePaths(name = "demo", root = remoteWorkDir()) {
  if (typeof name !== "string" || !NAME.test(name)) throw new Error(`a fixture name is lowercase letters, digits and dashes, got ${JSON.stringify(name)}`);
  const dir = join(resolve(root), name);
  return { dir, origin: join(dir, "origin.git"), originUrl: pathToFileURL(join(dir, "origin.git")).href, work: join(dir, "work") };
}

/**
 * Makes the fixture: two commits on `main` (text, a binary file, a
 * .gitignore), ignored files like a user has them (`.env`, an issue folder,
 * node_modules), and, with `dirty`, an uncommitted change and an untracked file.
 * An existing fixture is kept unless `fresh`.
 */
export function createRemoteWorkFixture({ name = "demo", root = remoteWorkDir(), fresh = false, dirty = true } = {}) {
  const paths = fixturePaths(name, root);
  if (fresh) removeRemoteWorkFixture({ name, root });
  if (!existsSync(join(paths.work, ".git"))) {
    rmSync(paths.dir, { recursive: true, force: true });
    const seed = join(paths.dir, "seed");
    mkdirSync(seed, { recursive: true });
    git(seed, ["init", "-q", "-b", "main"]);
    write(seed, "README.md", "# Remote work fixture\n\nA project Tau moves between test hosts.\n");
    write(seed, "src/app.js", "export const greeting = \"hello\";\n");
    write(seed, "assets/pixel.png", BINARY);
    write(seed, ".gitignore", ".env\n.scratch/\nnode_modules/\ndist/\n");
    git(seed, ["add", "-A"]);
    git(seed, ["commit", "-q", "-m", "chore: start the fixture"]);
    write(seed, "src/app.js", "export const greeting = \"hello\";\nexport const farewell = \"bye\";\n");
    git(seed, ["commit", "-q", "-am", "feat: say goodbye"]);
    git(paths.dir, ["clone", "-q", "--bare", seed, paths.origin]);
    rmSync(seed, { recursive: true, force: true });
    git(paths.dir, ["clone", "-q", paths.originUrl, paths.work], { GIT_ALLOW_PROTOCOL: "file" });
    write(paths.work, ".env", "FIXTURE_SECRET=not-a-secret\n");
    write(paths.work, ".scratch/issues/01-fixture.md", "# An ignored issue\n");
    write(paths.work, "node_modules/left-pad/index.js", "module.exports = (s) => s;\n");
  }
  if (dirty) {
    write(paths.work, "README.md", "# Remote work fixture\n\nA project Tau moves between test hosts.\n\nAn uncommitted line.\n");
    write(paths.work, "notes/draft.md", "An untracked draft.\n");
  }
  return { ...paths, head: git(paths.work, ["rev-parse", "HEAD"]), branch: git(paths.work, ["rev-parse", "--abbrev-ref", "HEAD"]) };
}

/** Deletes fixture `name`, and only what lies inside `root`. */
export function removeRemoteWorkFixture({ name = "demo", root = remoteWorkDir() } = {}) {
  const { dir } = fixturePaths(name, root);
  if (!dir.startsWith(resolve(root) + sep)) throw new Error(`refusing to remove ${dir}: not inside ${root}`);
  rmSync(dir, { recursive: true, force: true });
  return { removed: dir };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = process.argv.slice(2);
    const name = args.includes("--name") ? args[args.indexOf("--name") + 1] : "demo";
    const result = args.includes("--clean") ? removeRemoteWorkFixture({ name }) : createRemoteWorkFixture({ name, fresh: args.includes("--fresh") });
    console.log(JSON.stringify(result, null, 1));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
