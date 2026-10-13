// On SIGTERM, starts a detached helper and lives on briefly: a parent cleaning up while it is being stopped.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [record] = process.argv.slice(2);
let started = false;
process.on("SIGTERM", () => {
  if (started) return;
  started = true;
  const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  writeFileSync(record, String(helper.pid));
  setTimeout(() => process.exit(0), 400);
});
writeFileSync(`${record}.ready`, String(process.pid));
setInterval(() => {}, 1000);
