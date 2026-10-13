import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { processRunning as alive } from "../../src/main/test-support/process-running.js";
import { spawnAcpProcess } from "./client.js";

it.skipIf(process.platform === "win32").each(["EOF", "SIGKILL"] as const)("ends the whole process group on %s", async (action) => {
  const child = spawnAcpProcess({ command: process.execPath, args: [fileURLToPath(new URL("./fixtures/process-cli.mjs", import.meta.url))], cwd: process.cwd(), env: { ...process.env, TAU_AGENT_SCOPES: "0" } as Record<string, string> });
  let pids: number[] = [];
  try {
    pids = await new Promise<number[]>((resolve) => child.stdout.once("data", (chunk) => resolve(JSON.parse(String(chunk)) as number[])));
    expect(pids.every(alive)).toBe(true);
    if (action === "EOF") child.stdin.end();
    else child.kill("SIGKILL");
    await child.exited;
    await expect.poll(() => pids.filter(alive)).toEqual([]);
  } finally {
    child.kill("SIGKILL");
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
});
