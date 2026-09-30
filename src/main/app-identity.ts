import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

/**
 * Which app this is: the released Tau, or Tau Dev, a build of a checkout that
 * installs beside it (K132). Every name two installed apps could share comes
 * from here, so a dev build never reads or replaces the released app's state.
 */
export type AppFlavor = "stable" | "dev";

export interface AppIdentity {
  flavor: AppFlavor;
  /** The macOS bundle id, Windows' AppUserModelID, the LaunchAgent's owner. */
  appId: string;
  /** `app.setName`: the menu, the keychain's "<name> Safe Storage", the `.app`. */
  productName: string;
  /** Under Electron's appData: host.json, the locks, network.json, kit state. */
  userDataFolder: string;
  /** In the home folder: config, host token, packages, themes, grants, worktrees. */
  homeFolder: string;
  /** The fixed ports of network access and of the reverse-proxy listener. */
  networkPort: number;
  proxyPort: number;
  bonjourType: string;
  /** The host service's launchd label, systemd unit and Task Scheduler task. */
  service: { label: string; unit: string; task: string };
  /** The name `install:mac` suggests for the command-line link. */
  cliName: string;
  /** Carries a release feed and updates itself. */
  updates: boolean;
}

export const APP_IDENTITIES: Readonly<Record<AppFlavor, AppIdentity>> = {
  stable: {
    flavor: "stable",
    appId: "de.tbuck.tau",
    productName: "Tau",
    // The prototype's package name; renaming it would abandon every user's data.
    userDataFolder: "tau-pi-desktop-prototype",
    homeFolder: ".tau",
    networkPort: 7788,
    proxyPort: 7789,
    bonjourType: "_tau._tcp",
    // The label predates de.tbuck.tau; a new one would leave an installed agent running beside it.
    service: { label: "dev.tbuck.tau.host", unit: "tau-host", task: "Tau Host" },
    cliName: "tau",
    updates: true,
  },
  dev: {
    flavor: "dev",
    appId: "de.tbuck.tau.dev",
    productName: "Tau Dev",
    userDataFolder: "tau-dev",
    homeFolder: ".tau-dev",
    networkPort: 7790,
    proxyPort: 7791,
    bonjourType: "_tau-dev._tcp",
    service: { label: "de.tbuck.tau.dev.host", unit: "tau-dev-host", task: "Tau Dev Host" },
    cliName: "tau-dev",
    updates: false,
  },
};

/** The `package.json` field a Tau Dev build carries (electron-builder's `extraMetadata`). */
export const FLAVOR_FIELD = "tauFlavor";

export function flavorOf(manifest: unknown): AppFlavor {
  const value = manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>)[FLAVOR_FIELD] : undefined;
  return value === "dev" ? "dev" : "stable";
}

/**
 * The unpacked `package.json` of the installed app a binary belongs to. Found
 * from the binary, not from the code, because a workbench overlay runs code
 * from userData and a checkout's Electron has no such file.
 */
export function packagedManifestPath(execPath: string, platform: NodeJS.Platform): string {
  const path = platform === "win32" ? win32 : posix;
  const resources = platform === "darwin" ? path.join(path.dirname(execPath), "..", "Resources") : path.join(path.dirname(execPath), "resources");
  return path.join(resources, "app.asar.unpacked", "package.json");
}

export function readAppFlavor(manifestPath: string): AppFlavor {
  try {
    return flavorOf(JSON.parse(readFileSync(manifestPath, "utf8")));
  } catch {
    return "stable";
  }
}

let current: AppIdentity | undefined;

/** This process's identity: the window, its host, a service host and `service-cli` agree on it. */
export function appIdentity(): AppIdentity {
  current ??= APP_IDENTITIES[readAppFlavor(packagedManifestPath(process.execPath, process.platform))];
  return current;
}

/** The app's own folder in the home folder: `~/.tau`, or `~/.tau-dev` for Tau Dev. */
export function tauHomeDir(home: string = homedir()): string {
  return join(home, appIdentity().homeFolder);
}

/** Electron's `appData` joined with the app's folder: the userData without `TAU_USER_DATA`. */
export function defaultUserData(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, identity: AppIdentity = appIdentity()): string {
  const folder = identity.userDataFolder;
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", folder);
  if (platform === "win32") return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), folder);
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), folder);
}
