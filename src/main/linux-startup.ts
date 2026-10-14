import { execFileSync } from "node:child_process";
import type { CommandLine } from "electron";

const colorManager = "WaylandWpColorManagerV1";
const affectedReleases: Readonly<Record<string, string>> = {
  "0.48.0": "5ee35f914f921e5696030698e74fb5566a804768",
  "0.48.1": "29e2e59fdbab8ed2cc23a20e3c6043d5decb5cdc",
  "0.49.0": "9958d297641b5c84dcff93f9039d80a5ad37ab00",
  "0.50.0": "c4a4c341568944bd4fb9cd503558b2de602c0213",
  "0.50.1": "4e242d086e20b32951fdc0ebcbfb4d41b5be8dcc",
};

function containsColorManager(features: string): boolean {
  return features.split(",").some((entry) => entry.trim().replace(/^\*/, "").split(/[<:]/, 1)[0]?.trim() === colorManager);
}

// Without a platform switch Electron picks Wayland itself whenever a Wayland display is there.
function nativeWayland(commandLine: Pick<CommandLine, "getSwitchValue">): boolean {
  const platform = commandLine.getSwitchValue("ozone-platform") || commandLine.getSwitchValue("ozone-platform-hint") || "auto";
  return platform === "wayland" || platform === "auto" && Boolean(process.env.WAYLAND_DISPLAY);
}

/** Must run synchronously before the launcher's first await. */
export function configureEarlyLinuxStartup(commandLine: Pick<CommandLine, "getSwitchValue" | "appendSwitch">): void {
  if (process.platform !== "linux" || !nativeWayland(commandLine)) return;
  const desktop = process.env.XDG_CURRENT_DESKTOP?.trim() || process.env.XDG_SESSION_DESKTOP || "";
  if (!desktop.split(":").some((token) => token.trim().toLowerCase() === "hyprland")) return;
  const disabled = commandLine.getSwitchValue("disable-features");
  if (containsColorManager(disabled) || containsColorManager(commandLine.getSwitchValue("enable-features"))) return;

  try {
    const release: unknown = JSON.parse(execFileSync("hyprctl", ["version", "-j"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000, maxBuffer: 65536,
    }));
    if (!release || typeof release !== "object") return;
    const { version, tag, commit, dirty } = release as Record<string, unknown>;
    // Release tags alone can also describe later builds with the protocol fix.
    if (typeof version !== "string" || !Object.hasOwn(affectedReleases, version)
      || commit !== affectedReleases[version] || tag !== `v${version}` || dirty !== false) return;
  } catch {
    return;
  }

  // These releases reject set_primaries despite advertising it (hyprwm/Hyprland#9444).
  commandLine.appendSwitch("disable-features", disabled ? `${disabled},${colorManager}` : colorManager);
}
