import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { backgroundPriorityPrefix } from "./priority.js";

const prefix = backgroundPriorityPrefix();
const run = promisify(execFile);

/**
 * A lowered shell that waits on stdin. Everything is read from outside at
 * normal priority: a busy machine starves the shell itself by design.
 */
async function withLoweredShell(read: (pid: number) => Promise<void>): Promise<{ output: string; code: number | null }> {
  const shell = spawn("/bin/bash", ["-c", `${prefix}\necho ready; read _; exit 3`], { stdio: ["pipe", "pipe", "inherit"] });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    shell.once("error", reject);
    shell.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("ready\n")) resolve();
    });
  });
  try {
    await read(shell.pid!);
  } finally {
    shell.stdin.end("\n");
  }
  const code = await new Promise<number | null>((resolve) => shell.once("exit", resolve));
  return { output, code };
}

describe.skipIf(!prefix)("backgroundPriorityPrefix in a real shell", () => {
  it("lowers the shell, silently, and leaves its exit status alone", async () => {
    const result = await withLoweredShell(async (pid) => {
      const [nice, pri] = (await run("ps", ["-o", "ni=,pri=", "-p", String(pid)])).stdout.trim().split(/\s+/u).map(Number);
      expect(nice).toBeGreaterThanOrEqual(10);
      // Darwin's background band sits at priority 4.
      if (process.platform === "darwin") expect(pri).toBeLessThanOrEqual(4);
      if (process.platform === "linux") {
        const io = await run("ionice", ["-p", String(pid)]).then(({ stdout }) => stdout, () => undefined);
        if (io !== undefined) expect(io).toMatch(/idle/u);
      }
    });
    expect(result).toEqual({ output: "ready\n", code: 3 });
  });
});
