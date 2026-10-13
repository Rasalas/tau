import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => {
  console.log(JSON.stringify([process.pid, child.pid]));
  if (process.env.TAU_SHELL_BACKGROUND_FIXTURE === "1") process.exit(0);
});
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
