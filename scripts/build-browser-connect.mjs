// Rebuild the separately shipped browser TLS adapter from its locked Rust sources.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../browser-connect/", import.meta.url));
const cargo = process.env.TAU_CONNECT_CARGO ?? "cargo";
const bindgen = process.env.TAU_CONNECT_WASM_BINDGEN ?? "wasm-bindgen";
const env = { ...process.env };
// Apple's ar discards WASM objects. Rust's llvm-tools component supplies a
// compatible archiver without requiring a separately installed LLVM package.
if (process.platform === "darwin" && !env.AR_wasm32_unknown_unknown) {
  const sysroot = execFileSync(process.env.TAU_CONNECT_RUSTC ?? "rustc", ["--print", "sysroot"], { env, encoding: "utf8" }).trim();
  const host = execFileSync(process.env.TAU_CONNECT_RUSTC ?? "rustc", ["-vV"], { env, encoding: "utf8" }).match(/^host: (.+)$/mu)?.[1];
  env.AR_wasm32_unknown_unknown = join(sysroot, "lib", "rustlib", host, "bin", "llvm-ar");
}
execFileSync(cargo, ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "--jobs", "1"], { cwd: root, env, stdio: "inherit" });
const metadata = JSON.parse(execFileSync(cargo, ["metadata", "--locked", "--format-version", "1", "--filter-platform", "wasm32-unknown-unknown"], { cwd: root, env, encoding: "utf8" }));
const version = metadata.packages.find((pkg) => pkg.name === "wasm-bindgen").version;
if (!execFileSync(bindgen, ["--version"], { encoding: "utf8" }).includes(version)) throw new Error(`Use wasm-bindgen-cli ${version}, matching Cargo.lock.`);
execFileSync(bindgen, [join(root, "target/wasm32-unknown-unknown/release/tau_browser_connect.wasm"), "--target", "web", "--out-dir", join(root, "pkg")], { env, stdio: "inherit" });
const licenses = [];
for (const pkg of metadata.packages.sort((a, b) => a.name.localeCompare(b.name))) {
  if (pkg.name === "tau-browser-connect") continue;
  const folder = join(pkg.manifest_path, "..");
  const files = (await readdir(folder, { recursive: true })).filter((file) => /(^|\/)(LICENSE[^/]*|COPYING[^/]*|COPYRIGHT[^/]*)$/iu.test(file));
  const texts = [];
  for (const file of files) { try { texts.push(`${file}\n${await readFile(join(folder, file), "utf8")}`); } catch { /* A directory named LICENSE is covered by its child files. */ } }
  if (!texts.length) {
    // Workspace crates sometimes omit their shared license from the published
    // archive. Preserve it from a sibling crate in the same upstream repository.
    for (const sibling of metadata.packages.filter((candidate) => candidate.name !== pkg.name && candidate.repository === pkg.repository && candidate.license?.replaceAll("/", " OR ") === pkg.license?.replaceAll("/", " OR "))) {
      const parent = join(sibling.manifest_path, "..");
      for (const file of await readdir(parent)) if (/^(LICENSE|COPYING|COPYRIGHT)/iu.test(file)) {
        try { texts.push(`${sibling.name}/${file}\n${await readFile(join(parent, file), "utf8")}`); } catch { /* directories */ }
      }
      if (texts.length) break;
    }
  }
  if (!texts.length) throw new Error(`Missing license text for ${pkg.name} ${pkg.version}.`);
  licenses.push(`${pkg.name} ${pkg.version}\n${pkg.license ?? ""}\n${pkg.repository ?? ""}\n${texts.join("\n")}\n`);
}
await writeFile(join(root, "pkg/THIRD-PARTY-LICENSES.txt"), `${licenses.join("\n").replaceAll("\r\n", "\n").replace(/[ \t]+$/gmu, "").trimEnd()}\n`);
const files = ["Cargo.toml", "Cargo.lock", ".cargo/config.toml", "src/lib.rs", "pkg/tau_browser_connect.js", "pkg/tau_browser_connect_bg.wasm", "pkg/THIRD-PARTY-LICENSES.txt"];
const hashes = {};
for (const file of files) hashes[file] = createHash("sha256").update(await readFile(join(root, file))).digest("hex");
await writeFile(join(root, "pkg/manifest.json"), `${JSON.stringify({ wasmBindgen: version, hashes }, null, 2)}\n`);
