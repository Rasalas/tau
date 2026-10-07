import { describe, expect, it } from "vitest";
import { appChanged } from "../../.github/scripts/nightly-changes.mjs";

const pkg = (version, extra = {}) => JSON.stringify({ name: "tau", version, scripts: { build: "x" }, ...extra }, null, 2);
const lock = (version) => JSON.stringify({ name: "tau", version, lockfileVersion: 3, packages: { "": { name: "tau", version }, "node_modules/a": { version: "1.0.0" } } }, null, 2);
const kits = (version) => JSON.stringify({ name: "@tau/kits", version, engines: { api: "^1.53.0" } }, null, 2);

const LAST = { "package.json": pkg("0.7.38"), "package-lock.json": lock("0.7.38"), "kits/package.json": kits("0.7.38") };
const BUMPED = { "package.json": pkg("0.7.39"), "package-lock.json": lock("0.7.39"), "kits/package.json": kits("0.7.39") };
const reader = (trees) => (commit, file) => {
  const text = trees[commit][file];
  if (text === undefined) throw new Error(`${file} is not in ${commit}`);
  return text;
};

describe("whether a nightly has app changes to build", () => {
  it("has none when only a release's version bump landed", () => {
    expect(appChanged(Object.keys(BUMPED), reader({ last: LAST, head: BUMPED }), "last", "head")).toBe(false);
    expect(appChanged(["package.json"], reader({ last: LAST, head: { ...LAST, "package.json": pkg("0.7.39") } }), "last", "head")).toBe(false);
    expect(appChanged([], reader({ last: LAST, head: LAST }), "last", "head")).toBe(false);
  });

  it("has some as soon as a shipped file beyond the version fields changed", () => {
    expect(appChanged([...Object.keys(BUMPED), "src/main.ts"], reader({ last: LAST, head: BUMPED }), "last", "head")).toBe(true);
    const script = { ...BUMPED, "package.json": pkg("0.7.39", { scripts: { build: "y" } }) };
    expect(appChanged(["package.json"], reader({ last: LAST, head: script }), "last", "head")).toBe(true);
    const dependency = { ...BUMPED, "package-lock.json": lock("0.7.39").replace('"1.0.0"', '"1.0.1"') };
    expect(appChanged(["package-lock.json"], reader({ last: LAST, head: dependency }), "last", "head")).toBe(true);
  });

  it("has some when a version file cannot be read on one side", () => {
    const { "kits/package.json": _removed, ...without } = BUMPED;
    expect(appChanged(["kits/package.json"], reader({ last: LAST, head: without }), "last", "head")).toBe(true);
  });

  it("has none when only docs, tests and CI changed beside the bump", () => {
    const files = [...Object.keys(BUMPED), "docs/RELEASE.md", "README.md", ".github/workflows/release.yml", ".github/scripts/nightly-changes.mjs", "scripts/packaging/release-workflow.test.mjs", "src/renderer/components/Composer.send-mode.test.tsx"];
    expect(appChanged(files, reader({ last: LAST, head: BUMPED }), "last", "head")).toBe(false);
    expect(appChanged([...files, "scripts/packaging/portable-host.mjs"], reader({ last: LAST, head: BUMPED }), "last", "head")).toBe(true);
  });
});
