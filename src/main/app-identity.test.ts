import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TAU_SERVICE_TYPE } from "../shared/discovery.js";
import { DEFAULT_NETWORK_SETTINGS } from "../shared/connections.js";
import { APP_IDENTITIES, FLAVOR_FIELD, appIdentity, defaultUserData, flavorOf, packagedManifestPath, readAppFlavor, tauHomeDir } from "./app-identity.js";
import { defaultNetworkSettings } from "./host-network.js";
import { builtFromSource, hostInstaller } from "./update-installers.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("app identity", () => {
  it("reads Tau Dev only from the field a dev build carries", () => {
    expect(flavorOf({ [FLAVOR_FIELD]: "dev" })).toBe("dev");
    expect(flavorOf({ name: "tau-pi-desktop-prototype" })).toBe("stable");
    expect(flavorOf({ [FLAVOR_FIELD]: "nightly" })).toBe("stable");
    expect(flavorOf(undefined)).toBe("stable");
  });

  it("finds the unpacked package.json from the app's binary on each platform", () => {
    expect(packagedManifestPath("/Applications/Tau Dev.app/Contents/MacOS/Tau Dev", "darwin"))
      .toBe("/Applications/Tau Dev.app/Contents/Resources/app.asar.unpacked/package.json");
    expect(packagedManifestPath("/opt/Tau/tau", "linux")).toBe("/opt/Tau/resources/app.asar.unpacked/package.json");
    expect(packagedManifestPath("C:\\Program Files\\Tau\\Tau.exe", "win32")).toBe("C:\\Program Files\\Tau\\resources\\app.asar.unpacked\\package.json");
  });

  it("is the released app without a manifest, and Tau Dev with one that says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-identity-"));
    dirs.push(dir);
    expect(readAppFlavor(join(dir, "missing.json"))).toBe("stable");
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "app", "package.json"), JSON.stringify({ version: "1.0.0", [FLAVOR_FIELD]: "dev" }));
    expect(readAppFlavor(join(dir, "app", "package.json"))).toBe("dev");
    // Tests run on Node, whose binary has no app beside it.
    expect(appIdentity()).toBe(APP_IDENTITIES.stable);
    expect(tauHomeDir("/Users/me")).toBe(join("/Users/me", ".tau"));
  });

  it("keeps the released app's names where they have always been", () => {
    const stable = APP_IDENTITIES.stable;
    expect(stable.bonjourType).toBe(TAU_SERVICE_TYPE);
    expect(defaultNetworkSettings(stable)).toEqual(DEFAULT_NETWORK_SETTINGS);
    expect(defaultUserData("darwin", "/Users/me", {}, stable)).toBe("/Users/me/Library/Application Support/tau-pi-desktop-prototype");
  });

  it("gives Tau Dev a name of its own for everything the two apps could share", () => {
    const { stable, dev } = APP_IDENTITIES;
    for (const key of ["appId", "productName", "userDataFolder", "homeFolder", "networkPort", "proxyPort", "bonjourType", "cliName"] as const) {
      expect(dev[key], key).not.toBe(stable[key]);
    }
    for (const key of ["label", "unit", "task"] as const) expect(dev.service[key], key).not.toBe(stable.service[key]);
    expect(new Set([stable.networkPort, stable.proxyPort, dev.networkPort, dev.proxyPort]).size).toBe(4);
    expect(defaultNetworkSettings(dev)).toMatchObject({ port: 7790, proxyPort: 7791 });
    expect(defaultUserData("linux", "/home/me", {}, dev)).toBe("/home/me/.config/tau-dev");
  });

  it("never updates Tau Dev, and says it is built from source", () => {
    const answer = hostInstaller({ env: {}, platform: "darwin", execPath: "/Applications/Tau Dev.app/Contents/MacOS/Tau Dev", appRoot: "/x/app.asar.unpacked", identity: APP_IDENTITIES.dev });
    expect(answer).toEqual({ unsupported: builtFromSource("Tau Dev") });
    expect(answer.unsupported).toMatch(/^Tau Dev is built from source/u);
  });
});
