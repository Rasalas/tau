#!/usr/bin/env node
// Public source checks only. Never invoke build, signing, provisioning or network tools.
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const help = `Usage: node scripts/release-readiness.mjs [--root <checkout>] [--json]
Read-only public source checks; no environment, credentials, network or subprocesses.
Exit 0: source checks pass, release evidence pending. Exit 1: failed source check. Exit 2: usage error.
Signing, artifacts, physical devices and platform QA always require separate evidence.
`;
const pendingEvidence = [
  { id: "ios-signing", action: "Release owner must validate separate App and TauWidgets distribution profiles, team V4MWQ28RZ2, App Group group.de.tbuck.tau and shared keychain access; verify production push on the signed app. No profiles or secret presence were inspected." },
  { id: "signed-artifacts", action: "With separate approval, run nonpublishing platform CI and inspect signed artifacts, feed signatures, architecture, install and upgrade behavior. Source checks cannot establish these." },
  { id: "physical-mobile", action: "Human must run docs/mobile-device-checklist.md on signed iOS and Android test builds, including push, background activity, widgets and dictation." },
  { id: "native-platforms", action: "Human must verify Windows, WSL, X11 and each supported Wayland compositor in disposable environments; fixtures do not prove native behavior." },
];

// Fixed public file allowlist. Reject links, special files and oversized inputs before reading.
function publicText(root, relative) {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("unsafe input");
  }
  const stat = lstatSync(current);
  if (!stat.isFile() || stat.size > 128 * 1024) throw new Error("unsafe input");
  return readFileSync(current, "utf8");
}

function main(args) {
  let root = defaultRoot;
  let json = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" && args.length === 1) { process.stdout.write(help); return 0; }
    if (seen.has(arg)) throw new Error("usage");
    seen.add(arg);
    if (arg === "--json") json = true;
    else if (arg === "--root" && args[i + 1] && !args[i + 1].startsWith("--")) root = path.resolve(args[++i]);
    else throw new Error("usage");
  }
  const checks = [];
  // A missing checkout is a check failure too; do not echo paths or filesystem errors.
  try { root = realpathSync(root); } catch { root = null; }
  function check(id, files, predicate) {
    try {
      if (!root) throw new Error("missing checkout");
      const ok = predicate(...files.map(file => publicText(root, file)));
      checks.push({ id, status: ok ? "pass" : "fail", reason: ok ? "Public source assertion matched." : "Public source assertion did not match." });
    } catch {
      checks.push({ id, status: "fail", reason: "Required public input is missing, unsafe or unreadable." });
    }
  }
  check("mobile-version-range", ["package.json"], text => {
    const version = JSON.parse(text).version;
    if (typeof version !== "string") return false;
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (!match) return false;
    const [major, minor, patch] = match.slice(1).map(Number);
    const code = (major * 10000 + minor * 100 + patch) * 100 + 99;
    return minor < 100 && patch < 100 && Number.isSafeInteger(code) && code <= 2100000000;
  });
  const app = "mobile/ios/App/App/App.entitlements";
  const widget = "mobile/ios/App/TauWidgets/TauWidgets.entitlements";
  const arrayHas = (text, key, value) => {
    const match = new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(text);
    return !!match && match[1].includes(`<string>${value}</string>`);
  };
  check("ios-shared-app-group", [app, widget], (a, w) => [a, w].every(t => arrayHas(t, "com.apple.security.application-groups", "group.de.tbuck.tau")));
  check("ios-shared-keychain", [app, widget], (a, w) => [a, w].every(t => arrayHas(t, "keychain-access-groups", "$(AppIdentifierPrefix)de.tbuck.tau.shared")));
  check("ios-target-source-wiring", ["mobile/ios/App/App.xcodeproj/project.pbxproj"], t =>
    t.includes("TauWidgets.appex in Embed app extensions") &&
    t.includes("name = TauWidgets;") &&
    ["de.tbuck.tau;", "de.tbuck.tau.widgets;"].every(id => t.includes(`PRODUCT_BUNDLE_IDENTIFIER = ${id}`)) &&
    ["App/App.entitlements;", "TauWidgets/TauWidgets.entitlements;"].every(p => t.includes(`CODE_SIGN_ENTITLEMENTS = ${p}`)));
  check("ios-profile-validator-source-policy", ["scripts/packaging/ios-profiles.py"], t =>
    ["IOS_WIDGET_PROFILE", "production", "ProvisionedDevices", "ExpirationDate", "group.de.tbuck.tau", "$(TAU_PROFILE_$(TARGET_NAME))"].every(s => t.includes(s)));
  check("android-source-identity", ["mobile/android/app/build.gradle"], t =>
    /applicationId\s+"de\.tbuck\.tau"/.test(t) && t.includes("if (uploadKeystore) signingConfig signingConfigs.upload") && t.includes("tauAndroidRevision > 99"));
  const sourceChecksPassed = checks.every(c => c.status === "pass");
  const report = { schemaVersion: 1, scope: "public-source-only", sourceChecksPassed, releaseReady: null, readiness: "evidence-pending", checks, pendingEvidence };
  if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else {
    for (const c of checks) console.log(`${c.status.toUpperCase()} ${c.id}: ${c.reason}`);
    console.log("RELEASE EVIDENCE PENDING: source checks do not verify signing, builds or devices, and do not establish a release failure.");
    for (const b of pendingEvidence) console.log(`PENDING ${b.id}: ${b.action}`);
  }
  return sourceChecksPassed ? 0 : 1;
}

try { process.exitCode = main(process.argv.slice(2)); }
catch { process.stderr.write(help); process.exitCode = 2; }
