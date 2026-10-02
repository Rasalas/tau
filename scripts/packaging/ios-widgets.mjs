#!/usr/bin/env node
// Leaves the TauWidgets extension and the App Group out of the iOS project unless
// TAU_IOS_WIDGETS=1. Rewrites the checkout in place; meant for CI (K163, K164).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_GROUPS = "com.apple.security.application-groups";

export function widgetsEnabled(env = process.env) {
  return env.TAU_IOS_WIDGETS === "1";
}

/** The App target no longer depends on or embeds TauWidgets; the target itself stays. */
export function projectWithoutWidgets(text) {
  const dependency = /\n\t\t(\w{24}) \/\* PBXTargetDependency \*\/ = \{[^}]*?\bname = TauWidgets;/u.exec(text)?.[1];
  const embed = /\n\t\t(\w{24}) \/\* TauWidgets\.appex in [^*]+\*\/ = \{isa = PBXBuildFile;/u.exec(text)?.[1];
  if (!dependency || !embed) throw new Error("The project has no TauWidgets dependency or embed phase to remove.");
  const listed = (id) => new RegExp(`\\n\\t+${id} /\\* [^*]+ \\*/,(?=\\n)`, "gu");
  const result = text.replace(listed(dependency), "").replace(listed(embed), "");
  if (listed(dependency).test(result) || listed(embed).test(result) || result.length === text.length) {
    throw new Error("TauWidgets is still referenced by the App target.");
  }
  return result;
}

export function entitlementsWithoutAppGroup(text) {
  const result = text.replace(/\n\t<key>com\.apple\.security\.application-groups<\/key>\n\t<array>[\s\S]*?<\/array>/u, "");
  if (result === text || result.includes(APP_GROUPS)) throw new Error(`App.entitlements has no ${APP_GROUPS} to remove.`);
  return result;
}

export function stripWidgets(iosAppDir) {
  const project = path.join(iosAppDir, "App.xcodeproj", "project.pbxproj");
  const entitlements = path.join(iosAppDir, "App", "App.entitlements");
  writeFileSync(project, projectWithoutWidgets(readFileSync(project, "utf8")));
  writeFileSync(entitlements, entitlementsWithoutAppGroup(readFileSync(entitlements, "utf8")));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? "mobile/ios/App";
  if (widgetsEnabled()) {
    console.log("TAU_IOS_WIDGETS=1: the app keeps TauWidgets and the App Group.");
  } else {
    stripWidgets(dir);
    console.log("TAU_IOS_WIDGETS is not 1: the app is built without TauWidgets and without the App Group.");
  }
}
