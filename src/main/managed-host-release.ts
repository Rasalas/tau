import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_PUBLIC_KEYS } from "../shared/release-keys.js";
import { downloadVerified, readReleaseInfo, safeReleaseName, type Fetch } from "./release-feed.js";

export type ManagedHostPlatform = "linux" | "darwin" | "win32";
export type ManagedHostArch = "x64" | "arm64";
export const MANAGED_HOST_FEED = "https://github.com/Rasalas/tau-releases/releases/latest/download/";

/** The exact signed portable release, checked on the desktop before any upload. */
export async function prepareManagedHostRelease(platform: ManagedHostPlatform, arch: ManagedHostArch, cacheDir: string, signal?: AbortSignal, fetchUrl: Fetch = fetch, keys: readonly string[] = RELEASE_PUBLIC_KEYS) {
  if (!["linux", "darwin", "win32"].includes(platform) || !["x64", "arm64"].includes(arch) || keys.length === 0) throw new Error("A supported host target and trusted signing key are required.");
  const base = MANAGED_HOST_FEED;
  const info = await readReleaseInfo(fetchUrl, base, `latest-host-${platform}-${arch}.yml`, keys, signal);
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(info.version)) throw new Error("The signed Tau release names an invalid version.");
  const expected = `Tau-host-${info.version}-${platform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`;
  const file = info.files.find((entry) => entry.url === expected && safeReleaseName(entry.url) === expected);
  if (!file) throw new Error(`The signed Tau release has no portable host for ${platform}/${arch}.`);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const path = join(cacheDir, safeReleaseName(file.url)!);
  await downloadVerified(fetchUrl, `https://github.com/Rasalas/tau-releases/releases/download/v${encodeURIComponent(info.version)}/${safeReleaseName(file.url)!}`, path, file, signal);
  return { path, sha512: file.sha512, version: info.version };
}

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** No privilege escalation. A release keeps its own directory; current changes atomically. */
export function portableBootstrapScript(platform: "linux" | "darwin", version: string, sha512: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(version) || !/^[A-Za-z0-9+/]{86}==$/u.test(sha512)) throw new Error("Invalid portable release metadata.");
  const executable = platform === "darwin" ? "Tau.app/Contents/MacOS/Tau" : "tau";
  const resources = platform === "darwin" ? "Tau.app/Contents/Resources" : "resources";
  return `set -eu
archive=$1
root=$2
command -v openssl >/dev/null || { echo 'Install openssl before setting up Tau' >&2; exit 1; }
actual=$(openssl dgst -sha512 -binary "$archive" | openssl base64 -A)
[ "$actual" = ${shellQuote(sha512)} ] || { echo 'Tau archive checksum mismatch' >&2; exit 1; }
tar -tzf "$archive" | awk 'BEGIN { ok=1 } /^\\// { ok=0 } /(^|\\/)\\.\\.(\\/|$)/ { ok=0 } seen[$0]++ { ok=0 } END { exit !ok }' || { echo 'Unsafe Tau archive path' >&2; exit 1; }
mkdir -p "$root/releases"
if [ ! -x "$root/releases/${version}/${executable}" ]; then
  stage=$(mktemp -d "$root/releases/.install-XXXXXXXX")
  trap 'rm -rf "$stage"' EXIT HUP INT TERM
  tar -xzf "$archive" -C "$stage"
  [ -x "$stage/${executable}" ]
  mv "$stage" "$root/releases/${version}"
  trap - EXIT HUP INT TERM
fi
rm -f "$root/current.next"
ln -s "releases/${version}" "$root/current.next"
mv ${platform === "linux" ? "-fT" : "-fh"} "$root/current.next" "$root/current"
mkdir -p "$root/data"
chmod 700 "$root/data"
live=$(ELECTRON_RUN_AS_NODE=1 TAU_USER_DATA="$root/data" "$root/current/${executable}" -e ${shellQuote(`const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.env.TAU_USER_DATA+"/host.json","utf8"));if(d.version!==${JSON.stringify(version)})process.exit(1);const s=new WebSocket(d.url);const t=setTimeout(()=>process.exit(1),2000);s.onopen=()=>s.send(JSON.stringify({type:"hello",id:"probe",hello:{protocol:1,token:fs.readFileSync(d.tokenPath,"utf8").trim(),auxiliary:true}}));s.onmessage=e=>{const f=JSON.parse(String(e.data));if(f.type==="hello-reply"&&f.reply.owner!==false){clearTimeout(t);console.log("ready");s.close();}};s.onerror=()=>process.exit(1);}catch{process.exit(1);}`)} 2>/dev/null || true)
if [ "$live" != ready ]; then
  ELECTRON_RUN_AS_NODE=1 TAU_USER_DATA="$root/data" TAU_HOST_LOCAL_FILES=0 "$root/current/${executable}" "$root/current/${resources}/app.asar.unpacked/bin/tau.mjs" service install
fi
`;
}
