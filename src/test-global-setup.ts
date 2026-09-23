import { randomUUID } from "node:crypto";
import type { TestProject } from "vitest/node";
import { findRunProcesses, type RunProcess } from "./main/test-support/test-processes.js";

declare module "vitest" {
  export interface ProvidedContext {
    tauTestRun: string;
  }
}

/** How long a child that was told to stop may take to exit before it counts as left behind. */
const GRACE_MS = 5_000;

// Every worker tags its environment with this run's id (src/test-setup.ts), so
// whatever a test starts carries it. After the last file, anything still alive
// with the tag was left behind: it is killed and the run fails with its command.
export default function setup(project: TestProject): () => Promise<void> {
  const run = randomUUID();
  project.provide("tauTestRun", run);
  return async () => {
    const survivors = await settle(run);
    if (survivors.length === 0) return;
    for (const survivor of survivors) {
      try { process.kill(survivor.pid, "SIGKILL"); } catch { /* exited meanwhile */ }
    }
    const lines = survivors.map((survivor) => `  ${survivor.pid} ${survivor.command}${survivor.file ? `\n      started by ${survivor.file}` : ""}`);
    throw new Error(`The tests left ${survivors.length} process(es) running; they were killed now:\n${lines.join("\n")}`);
  };
}

async function settle(run: string): Promise<RunProcess[]> {
  const deadline = Date.now() + GRACE_MS;
  let survivors = findRunProcesses(run);
  while (survivors.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    survivors = findRunProcesses(run);
  }
  return survivors;
}
