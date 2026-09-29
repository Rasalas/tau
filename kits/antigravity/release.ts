/**
 * The Antigravity ACP server Google publishes for editors, pinned per
 * platform. The URLs, sizes and hashes come from the official registry entry
 * (https://github.com/agentclientprotocol/registry, `antigravity-acp/agent.json`);
 * a new release means a new row here, never a silent upgrade. Checked 2026-09-07.
 */
export const ANTIGRAVITY_RELEASE_VERSION = "agy_acp_server_1.1.1";

export interface ReleaseFile {
  name: string;
  bytes: number;
}

export interface ReleaseAsset {
  key: string;
  version: string;
  url: string;
  sha256: string;
  archiveBytes: number;
  executable: ReleaseFile;
  harness: ReleaseFile;
}

const BASE = "https://dl.google.com/agy-extensions/releases";

function asset(key: string, folder: string, file: string, sha256: string, archiveBytes: number, executableBytes: number, harnessBytes: number): ReleaseAsset {
  const names = executableNames(key.startsWith("win32") ? "win32" : "posix");
  return {
    key,
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: `${BASE}/${folder}/agy-acp-server-${ANTIGRAVITY_RELEASE_VERSION}-${file}.zip`,
    sha256,
    archiveBytes,
    executable: { name: names.executable, bytes: executableBytes },
    harness: { name: names.harness, bytes: harnessBytes },
  };
}

export const RELEASE_ASSETS: readonly ReleaseAsset[] = [
  asset("darwin-arm64", "macos", "darwin-arm64", "fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189", 316_014_828, 802_163_856, 116_766_704),
  asset("linux-x64", "linux", "linux-x86_64", "38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df", 681_969_407, 1_880_360_328, 128_966_920),
  asset("linux-arm64", "linux", "linux-arm64", "ed69e64b308fcb123ab54bf3277bf9cb0d651064f885ea5aab0ff520c7175398", 656_572_786, 1_862_073_131, 122_158_704),
  asset("win32-x64", "windows", "windows-x86_64", "47cb50eef14f0a4655d78cfcfda869bcea7aaee5f9787e936bc2935ea612c3b8", 468_238_392, 430_801_616, 130_971_800),
  asset("win32-arm64", "windows", "windows-arm64", "35f4b1f47ba6a3fea7b0a3e30010df5ea73a64b4f0e7cf991cddc673ddfbcafc", 468_521_191, 435_075_816, 122_455_704),
];

/** The two files every release carries: the ACP server and the harness it spawns. */
export function executableNames(platform: string): { executable: string; harness: string } {
  return platform === "win32"
    ? { executable: "agy_acp_server.exe", harness: "localharness_external.exe" }
    : { executable: "agy_acp_server.par", harness: "localharness_external" };
}

export function releaseAssetFor(platform: string, arch: string): ReleaseAsset | undefined {
  return RELEASE_ASSETS.find((entry) => entry.key === `${platform}-${arch}`);
}
