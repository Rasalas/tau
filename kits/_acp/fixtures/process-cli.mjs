import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);"], { stdio: ["ignore", "pipe", "ignore"] });
child.stdout.once("data", () => console.log(JSON.stringify([process.pid, child.pid])));
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
setInterval(() => {}, 1000);
