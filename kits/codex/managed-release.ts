/** Official complete packages, including Codex's sandbox and runtime helpers.
 * Source: https://github.com/openai/codex/releases/tag/rust-v0.159.2
 * Sizes and SHA-256 digests are pinned from that release's asset metadata.
 */
export const MANAGED_CODEX_VERSION = "0.159.2";

export interface ManagedCodexAsset {
  target: string;
  bytes: number;
  sha256: string;
}

const ASSETS: Record<string, ManagedCodexAsset> = {
  "darwin-arm64": { target: "aarch64-apple-darwin", bytes: 129522674, sha256: "38aaf6dce63099fd10988948d03bbc6c0474253aef6961fcbe60f8d154b39101" },
  "darwin-x64": { target: "x86_64-apple-darwin", bytes: 140813958, sha256: "6b9b38bfad6ac8019aa6a243ee3ab11d3e22889eafd5458b0344cf20e797e680" },
  "linux-arm64": { target: "aarch64-unknown-linux-musl", bytes: 150270060, sha256: "05a524a463cadf7e3e22c7f923539c0d0b74c3e78b1f5f1fab52e50e6fb3312f" },
  "linux-x64": { target: "x86_64-unknown-linux-musl", bytes: 159961162, sha256: "9e2d29a713b94478b240dec2f10e11324cd05fad76dc43e7c639bdf8a1337a6b" },
  "win32-arm64": { target: "aarch64-pc-windows-msvc", bytes: 144725539, sha256: "f017342f77ec57dffff57e59723738ac9f228ddab4f656c2bdfc65f1d9b87da3" },
  "win32-x64": { target: "x86_64-pc-windows-msvc", bytes: 156614559, sha256: "a7ab591043d99e8a88d0c2bebf15f810b15599a71148c4af944a755af3c71eef" },
};

export function managedCodexAsset(platform: string, arch: string): ManagedCodexAsset | undefined {
  return ASSETS[`${platform}-${arch}`];
}
