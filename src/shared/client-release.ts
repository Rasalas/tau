import { defaultUpdateChannel, type UpdateChannel } from "./app-version.js";

/** The installed client release, independent of the machine running its threads. */
export interface ClientRelease {
  version: string;
  platform: "darwin" | "linux" | "win32";
  channel: UpdateChannel;
}

/** Development, isolated instances and a process-wide opt-out never advertise a release for statistics. */
export function clientReleaseQuery(packaged: boolean, version: string, platform: string, env: Record<string, string | undefined>): Record<string, string> {
  if (!packaged || env.TAU_USER_DATA || env.TAU_DEV_SERVER_URL || env.TAU_USAGE_STATISTICS === "0" || env.TAU_NO_FOCUS === "1") return {};
  if (!["darwin", "linux", "win32"].includes(platform)) return {};
  return { clientRelease: version, clientPlatform: platform };
}

export function readClientRelease(search: URLSearchParams): ClientRelease | undefined {
  const version = search.get("clientRelease");
  const platform = search.get("clientPlatform");
  if (!version || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/u.test(version)) return undefined;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return undefined;
  return { version, platform, channel: defaultUpdateChannel(version) };
}
