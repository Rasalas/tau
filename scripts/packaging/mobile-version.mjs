#!/usr/bin/env node
// The numbers the phone apps carry besides the version (package.json's, as
// both stores show it). Each store refuses a build whose number is not above
// the last one it took.
//
//   node scripts/packaging/mobile-version.mjs ios-build --run <n>     → CFBundleVersion
//   node scripts/packaging/mobile-version.mjs android-code [--version 1.2.3] → versionCode
import { isMain, main, packageVersion } from "./release.mjs";

/** TestFlight builds 1 to 9 were numbered by hand; the release workflow's start above them. */
export const IOS_BUILD_BASE = 100;

/** The iOS build number of a release run: grows with every run of release.yml. */
export function iosBuildNumber(run) {
  if (!Number.isInteger(run) || run < 1) throw new Error(`The run number must be a positive integer, not ${run}.`);
  return IOS_BUILD_BASE + run;
}

/**
 * Android's versionCode: (major·10000 + minor·100 + patch)·100 + revision, so 0.7.16 is 71600.
 * The revision (0–99) numbers Android-only rebuilds of one version; mobile/android/app/build.gradle
 * computes the same from `tauAndroidRevision`.
 */
export function androidVersionCode(version, revision = 0) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(version);
  if (!match) throw new Error(`"${version}" is not a version like 1.2.3.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (minor > 99 || patch > 99) throw new Error(`${version}: minor and patch must stay below 100 for the versionCode.`);
  if (!Number.isInteger(revision) || revision < 0 || revision > 99) throw new Error(`The Android revision must be 0–99, not ${revision}.`);
  return (major * 10_000 + minor * 100 + patch) * 100 + revision;
}

if (isMain(import.meta.url)) {
  main(() => {
    const [command, flag, value] = process.argv.slice(2);
    if (command === "ios-build" && flag === "--run") console.log(iosBuildNumber(Number(value)));
    else if (command === "android-code" && (flag === undefined || flag === "--version")) console.log(androidVersionCode(value ?? packageVersion()));
    else throw new Error("usage: mobile-version.mjs ios-build --run <n> | android-code [--version <1.2.3>]");
  });
}
