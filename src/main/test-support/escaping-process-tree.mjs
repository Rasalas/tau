// Descendants without the ownership marker (the caller ran us under `env -i`), one in its own
// process group. With `orphan`, a launcher starts the escapee and exits, leaving it parentless.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [record, mode] = process.argv.slice(2);
const idle = ["-e", "setInterval(() => {}, 1000)"];
const start = (options) => spawn(process.execPath, idle, { stdio: "ignore", ...options }).pid;
if (mode === "launcher") {
  writeFileSync(record, String(start({ detached: true })));
  setTimeout(() => process.exit(0), Number(process.env.TAU_ESCAPE_LAUNCHER_MS ?? 1500));
} else {
  const sibling = start({});
  const detached = start({ detached: true });
  const launcher = spawn(process.execPath, [process.argv[1], `${record}.orphan`, "launcher"], { stdio: "ignore" });
  writeFileSync(record, JSON.stringify([process.pid, sibling, detached, launcher.pid]));
  setInterval(() => {}, 1000);
}
