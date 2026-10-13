#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import "./fake-serve.mjs";

const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);"], {
  stdio: ["ignore", "pipe", "ignore"],
});
child.stdout.once("data", () => {
  writeFileSync(process.env.FAKE_PROCESS_PIDS, JSON.stringify([process.pid, child.pid]));
});
