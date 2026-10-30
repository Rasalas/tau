import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** Resolve after installation, allowing Electron's lazy downloader to write to stdout. */
export async function resolveElectronRuntime(root, scratch, run) {
  const metadata = join(scratch, "electron-runtime.json");
  const env = { ...process.env };
  delete env.ELECTRON_OVERRIDE_DIST_PATH;
  run(root, process.execPath, ["-e", `
    const executable = require("electron");
    require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ executable }), { flag: "wx", mode: 0o600 });
  `, metadata], { env });
  const { executable } = JSON.parse(await readFile(metadata, "utf8"));
  const { version } = JSON.parse(await readFile(join(root, "node_modules", "electron", "package.json"), "utf8"));
  if (typeof executable !== "string" || !isAbsolute(executable) || !/^\d+\.\d+\.\d+$/u.test(version ?? "")) {
    throw new Error("Invalid installed Electron runtime metadata");
  }
  return {
    executable,
    electronVersion: version,
    binarySha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
  };
}
