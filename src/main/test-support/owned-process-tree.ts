import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { spawnOwnedProcess } from "../owned-process.js";
import { processRunning } from "./process-running.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** A shell, its command and a grandchild stay alive until their owner stops them. */
export async function ownedProcessTree() {
  const fixture = fileURLToPath(new URL("./shell-process-tree.mjs", import.meta.url));
  const child = spawnOwnedProcess({
    command: "/bin/sh",
    args: ["-c", `echo $$; ${quote(process.execPath)} ${quote(fixture)} & wait`],
    env: { ...process.env, TAU_SHELL_BACKGROUND_FIXTURE: "0" },
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  let pids: number[] = [];
  const close = async () => {
    child.kill("SIGKILL");
    await exited;
    for (const pid of pids) {
      if (pid !== child.pid && processRunning(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      }
    }
  };
  try {
    await expect.poll(() => output.trim().split("\n").length, { timeout: 20_000 }).toBe(2);
    const [shell, descendants] = output.trim().split("\n");
    pids = [child.pid!, Number(shell), ...JSON.parse(descendants!) as number[]];
    expect(pids.every(processRunning)).toBe(true);
    return {
      pids,
      alive: () => pids.filter(processRunning),
      stop: async () => { child.kill("SIGTERM"); await exited; },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
