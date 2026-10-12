import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createClaudeCodeRuntimeAdapter } from "./runtime-adapter.js";

function running(pid: number): boolean {
  try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); }
  catch { return false; }
}

it.skipIf(process.platform === "win32")("closing a real SDK session ends its detached shell and grandchild", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-sdk-processes-"));
  const pidsFile = join(dir, "pids");
  let pids: number[] = [];
  const adapter = createClaudeCodeRuntimeAdapter({
    command: fileURLToPath(new URL("./fixtures/process-tree-cli.mjs", import.meta.url)),
    storePath: join(dir, "store.json"),
    env: { ...process.env, TAU_AGENT_SCOPES: "0", TAU_PROCESS_FIXTURE_ROOT: join(dir, "root"), TAU_PROCESS_FIXTURE_PIDS: pidsFile },
  });
  const session = adapter.openSession({ cwd: dir, claudeSessionId: randomUUID(), started: false, permissionLevel: "full", onMessage() {}, onExit() {} });
  void session.send("start the process fixture", "next").catch(() => undefined);
  try {
    await expect.poll(async () => {
      pids = await readFile(pidsFile, "utf8").then((text) => text.trim().split(/\s+/u).map(Number)).catch(() => []);
      return pids.length;
    }, { timeout: 20_000 }).toBe(2);
    expect(pids.every(running)).toBe(true);
    await session.close();
    await expect.poll(() => pids.filter(running), { timeout: 20_000 }).toEqual([]);
  } finally {
    await session.close();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await rm(dir, { recursive: true, force: true });
  }
});
