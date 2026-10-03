import { test } from "vitest";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "scripts/release-readiness.mjs");
const files = ["package.json", "mobile/ios/App/App/App.entitlements", "mobile/ios/App/TauWidgets/TauWidgets.entitlements", "mobile/ios/App/App.xcodeproj/project.pbxproj", "scripts/packaging/ios-profiles.py", "mobile/android/app/build.gradle"];
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tau-release-readiness-"));
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    copyFileSync(path.join(root, file), path.join(dir, file));
  }
  return dir;
}
function run(args, env = {}) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 10000, env: { ...process.env, ...env } });
}
function report(dir) {
  const result = run(["--root", dir, "--json"]);
  assert.equal(result.stderr, "");
  return { ...result, body: JSON.parse(result.stdout) };
}
function change(dir, file, before, after) {
  const target = path.join(dir, file);
  const text = readFileSync(target, "utf8");
  assert.ok(text.includes(before));
  writeFileSync(target, text.replaceAll(before, after));
}

test("passing public source checks never claim release readiness and leave inputs unchanged", t => {
  const dir = fixture(t);
  const before = files.map(f => readFileSync(path.join(dir, f)));
  const result = report(dir);
  assert.equal(result.status, 0);
  assert.equal(result.body.sourceChecksPassed, true);
  assert.equal(result.body.releaseReady, null);
  assert.equal(result.body.readiness, "evidence-pending");
  assert.equal(result.body.pendingEvidence.length, 4);
  files.forEach((f, i) => assert.deepEqual(readFileSync(path.join(dir, f)), before[i]));
});
test("human-readable output and help explain exit semantics", t => {
  const dir = fixture(t);
  const result = run(["--root", dir]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /RELEASE EVIDENCE PENDING/);
  assert.match(result.stdout, /do not establish a release failure/);
  assert.match(result.stdout, /PENDING ios-signing/);
  assert.equal(run(["--help"]).status, 0);
});
test("unknown, repeated and incomplete flags fail closed", () => {
  for (const args of [["--publish"], ["--root"], ["--root", "--json"], ["--json", "--json"], ["--help", "--json"]]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  }
});
test("missing inputs and invalid checkout produce bounded structured failures", t => {
  const dir = fixture(t);
  rmSync(path.join(dir, files[1]));
  for (const target of [dir, path.join(dir, "missing")]) {
    const result = report(target);
    assert.equal(result.status, 1);
    assert.equal(result.body.sourceChecksPassed, false);
    assert.equal(result.body.releaseReady, null);
    assert.equal(result.body.readiness, "evidence-pending");
    assert.ok(result.body.checks.some(c => c.status === "fail"));
  }
});
test("app group, keychain, widget embedding and Android identity drift fail", t => {
  const cases = [
    [files[2], "group.de.tbuck.tau", "group.wrong", "ios-shared-app-group"],
    [files[2], "$(AppIdentifierPrefix)de.tbuck.tau.shared", "wrong", "ios-shared-keychain"],
    [files[3], "TauWidgets.appex in Embed app extensions", "Wrong embed", "ios-target-source-wiring"],
    [files[5], 'applicationId "de.tbuck.tau"', 'applicationId "wrong"', "android-source-identity"],
    [files[4], "$(TAU_PROFILE_$(TARGET_NAME))", "wrong", "ios-profile-validator-source-policy"],
  ];
  for (const [file, before, after, id] of cases) {
    const dir = fixture(t);
    change(dir, file, before, after);
    const result = report(dir);
    assert.equal(result.status, 1);
    assert.equal(result.body.checks.find(c => c.id === id).status, "fail");
  }
});
test("invalid JSON and Android version collisions or overflow fail", t => {
  for (const version of ["0.1.100", "0.100.1", "999999.0.0", "0.1.1-nightly.1", null]) {
    const dir = fixture(t);
    writeFileSync(path.join(dir, "package.json"), version === null ? "invalid" : JSON.stringify({ version }));
    assert.equal(report(dir).status, 1);
  }
});
test("rejects malformed package.version types without regex coercion", t => {
  for (const version of [["0.7.38"], 738, true, null, {}, { value: "0.7.38" }]) {
    const dir = fixture(t);
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version }));
    const result = report(dir);
    assert.equal(result.status, 1);
    assert.equal(result.body.checks.find(c => c.id === "mobile-version-range").status, "fail");
  }
  const dir = fixture(t);
  writeFileSync(path.join(dir, "package.json"), "{}");
  assert.equal(report(dir).status, 1);
});
test("does not expose input text, inherited secrets or filesystem paths", t => {
  const dir = fixture(t);
  const canary = "PRIVATE_CANARY_DO_NOT_PRINT";
  writeFileSync(path.join(dir, "package.json"), canary);
  const result = run(["--root", dir, "--json"], { IOS_PROFILE: canary, TAU_RELEASE_SIGNING_KEY: canary });
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes(canary));
  assert.ok(!result.stderr.includes(canary));
  assert.ok(!result.stdout.includes(dir));
});
test("rejects file and directory symlinks before reading and rejects oversized inputs", t => {
  const dir = fixture(t);
  const secret = path.join(dir, "private");
  writeFileSync(secret, "PRIVATE_CANARY");
  rmSync(path.join(dir, "package.json"));
  symlinkSync(secret, path.join(dir, "package.json"));
  assert.equal(report(dir).status, 1);
  rmSync(path.join(dir, "package.json"));
  writeFileSync(path.join(dir, "package.json"), "x".repeat(128 * 1024 + 1));
  assert.equal(report(dir).status, 1);
  const android = path.join(dir, "mobile/android");
  rmSync(android, { recursive: true });
  symlinkSync(path.join(root, "mobile/android"), android, "dir");
  const result = report(dir);
  assert.equal(result.body.checks.find(c => c.id === "android-source-identity").status, "fail");
});
