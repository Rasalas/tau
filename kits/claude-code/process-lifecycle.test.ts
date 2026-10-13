import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { createClaudeCodeRuntimeAdapter } from "./runtime-adapter.js";

function running(pid: number): boolean {
  try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); }
  catch { return false; }
}

it.skipIf(process.platform === "win32").each(["close", "auth-parent", "auth-child"])("ending a real SDK session on %s ends its detached shell and grandchild", async (ending) => {
  const dir = await mkdtemp(join(tmpdir(), "tau-sdk-processes-"));
  const pidsFile = join(dir, "pids");
  let pids: number[] = [];
  const adapter = createClaudeCodeRuntimeAdapter({
    command: fileURLToPath(new URL("./fixtures/process-tree-cli.mjs", import.meta.url)),
    storePath: join(dir, "store.json"),
    env: { ...process.env, TAU_AGENT_SCOPES: "0", TAU_PROCESS_FIXTURE_ROOT: join(dir, "root"), TAU_PROCESS_FIXTURE_PIDS: pidsFile },
  });
  const session = adapter.openSession({ cwd: dir, claudeSessionId: randomUUID(), started: false, permissionLevel: "full", onMessage() {}, onExit() {} });
  const pending = session.send(ending, "next").catch((error: unknown) => error);
  try {
    await expect.poll(async () => {
      pids = await readFile(pidsFile, "utf8").then((text) => text.trim().split(/\s+/u).map(Number)).catch(() => []);
      return pids.length;
    }, { timeout: 20_000 }).toBe(2);
    expect(pids.every(running)).toBe(true);
    if (ending === "close") await session.close();
    else {
      process.kill(Number(await readFile(join(dir, "root"), "utf8")), "SIGUSR2");
      expect(await pending).toMatchObject({ name: "ClaudeAuthenticationError" });
      expect(session.closed).toBe(true);
    }
    await expect.poll(() => pids.filter(running), { timeout: 20_000 }).toEqual([]);
  } finally {
    await session.close();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await rm(dir, { recursive: true, force: true });
  }
});


it.skipIf(process.platform === "win32")("emits an authentication failure when the fixture is signalled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tau-sdk-auth-signal-"));
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/process-tree-cli.mjs", import.meta.url)), "--input-format", "stream-json"], {
    cwd: dir, env: { ...process.env, TAU_PROCESS_FIXTURE_ROOT: join(dir, "root"), TAU_PROCESS_FIXTURE_PIDS: join(dir, "pids") },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const lines = createInterface({ input: child.stdout });
  const failure = new Promise<unknown>((resolve, reject) => {
    lines.on("line", (line) => { const frame = JSON.parse(line); if (frame.error) resolve(frame); });
    child.once("exit", () => reject(new Error("Fixture exited before authentication failure")));
  });
  // Observe a rejection even if readiness fails before the signal is sent.
  void failure.catch(() => undefined);
  let pids: number[] = [];
  try {
    child.stdin.write(`${JSON.stringify({ type: "user", message: { content: "auth-parent" } })}\n`);
    await expect.poll(async () => {
      pids = await readFile(join(dir, "pids"), "utf8").then((text) => text.trim().split(/\s+/u).map(Number)).catch(() => []);
      return pids.length;
    }, { timeout: 20_000 }).toBe(2);
    child.kill("SIGUSR2");
    expect(await failure).toMatchObject({ type: "assistant", error: "authentication_failed", parent_tool_use_id: null });
  } finally {
    child.stdin.end();
    await exited;
    lines.close();
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
