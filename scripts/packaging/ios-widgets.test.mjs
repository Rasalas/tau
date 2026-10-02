import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_GROUPS, entitlementsWithoutAppGroup, projectWithoutWidgets, widgetsEnabled } from "./ios-widgets.mjs";

const project = readFileSync("mobile/ios/App/App.xcodeproj/project.pbxproj", "utf8");
const entitlements = readFileSync("mobile/ios/App/App/App.entitlements", "utf8");
const appTarget = (text) => /\/\* App \*\/ = \{\n\t+isa = PBXNativeTarget;[\s\S]*?\n\t\t\};/u.exec(text)[0];
const embedPhase = (text) => /\/\* Embed app extensions \*\/ = \{\n\t+isa = PBXCopyFilesBuildPhase;[\s\S]*?\n\t\t\};/u.exec(text)[0];

describe("ios-widgets", () => {
  it("builds the widgets only when TAU_IOS_WIDGETS is 1", () => {
    expect(widgetsEnabled({ TAU_IOS_WIDGETS: "1" })).toBe(true);
    for (const value of [undefined, "", "0", "true"]) expect(widgetsEnabled({ TAU_IOS_WIDGETS: value })).toBe(false);
  });

  it("drops the App target's dependency on TauWidgets and its embed, and keeps the target", () => {
    expect(appTarget(project)).toContain("/* PBXTargetDependency */");
    expect(embedPhase(project)).toContain("TauWidgets.appex in");
    const stripped = projectWithoutWidgets(project);
    expect(appTarget(stripped)).not.toContain("/* PBXTargetDependency */");
    expect(embedPhase(stripped)).not.toContain("TauWidgets.appex in");
    expect(stripped).toContain("isa = PBXNativeTarget;\n\t\t\tbuildConfigurationList = A5F74138483FB63E7ECDB744");
    expect(project.split("\n").length - stripped.split("\n").length).toBe(2);
    expect(() => projectWithoutWidgets(stripped)).toThrow();
  });

  it("removes only the App Group from the app's entitlements", () => {
    const stripped = entitlementsWithoutAppGroup(entitlements);
    expect(entitlements).toContain(APP_GROUPS);
    expect(stripped).not.toContain(APP_GROUPS);
    expect(stripped).toContain("<key>aps-environment</key>");
    expect(stripped).toContain("$(AppIdentifierPrefix)de.tbuck.tau.shared");
    expect(() => entitlementsWithoutAppGroup(stripped)).toThrow();
  });
});
