import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export async function buildWaylandHelpers(source, destination) {
  if (process.platform !== "linux") throw new Error("Native Wayland capture helpers must be built on Linux.");
  await mkdir(destination, { recursive: true });
  for (const backend of ["kde", "hyprland"]) {
    const target = join(root, ".tau-native", backend);
    execFileSync("cargo", ["build", "--release", "--locked", "--jobs", "1", "--manifest-path", join(source, backend, "Cargo.toml"), "--target-dir", target], { stdio: "inherit" });
    const executable = `tau-${backend}-snapshot`;
    await copyFile(join(target, "release", executable), join(destination, executable));
    await chmod(join(destination, executable), 0o755);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildWaylandHelpers(join(root, "kits", "snapshots", "native"), join(root, ".tau-native", "bundled"));
}
