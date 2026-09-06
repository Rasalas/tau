import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeCodeArgs, createClaudeCodeRuntimeAdapter, runtimePermissionPolicy } from "./runtime-adapter.js";

// Naming the interpreter directly drops one `env` PATH lookup per spawned
// turn. A node path containing a space cannot be a shebang, so such hosts keep
// the portable form.
const SHEBANG = process.execPath.includes(" ") ? "#!/usr/bin/env node" : `#!${process.execPath}`;

const STUB_SOURCES = {
  transport: "const args = process.argv.slice(2);\nif (args.at(-1) === 'hang') setInterval(() => {}, 1000); else process.stdout.write(JSON.stringify(args));\n",
  abort: "const args = process.argv.slice(2);\nif (args.at(-1) === 'hang') setInterval(() => {}, 1000); else process.stdout.write('ok');\n",
  recovery: "const args = process.argv.slice(2);\nconst prompt = args.at(-1);\nif (prompt === 'conflict' && !args.includes('--resume')) { process.stderr.write('session already exists'); process.exit(2); }\nif (prompt === 'missing' && args.includes('--resume')) { process.stderr.write('session not found'); process.exit(2); }\nprocess.stdout.write(args.includes('--resume') ? 'resumed' : 'created');\n",
  stderr: "process.stderr.write('e'.repeat(200)); process.exit(2);\n",
  stdout: "process.stdout.write('o'.repeat(200)); setInterval(() => {}, 1000);\n",
} as const;

describe("Claude Code runtime adapter", () => {
  // One temp directory and one stub per behavior for the whole file. Creating
  // and removing a directory inside every test made the spawning cases depend
  // on the host's filesystem load rather than on the adapter.
  let directory = "";
  const stub = (name: keyof typeof STUB_SOURCES | "policy"): string => join(directory, `claude-${name}-stub.mjs`);
  const store = (name: string): string => join(directory, `${name}-sessions.json`);
  let policyMarker = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tau-claude-adapter-"));
    policyMarker = join(directory, "policy-spawned");
    const write = async (path: string, source: string): Promise<void> => {
      await writeFile(path, source, { encoding: "utf8", mode: 0o700 });
      await chmod(path, 0o700);
    };
    await Promise.all([
      ...Object.entries(STUB_SOURCES).map(([name, source]) =>
        write(stub(name as keyof typeof STUB_SOURCES), `${SHEBANG}\n${source}`)),
      // Deliberately never executed: the policy check must reject first.
      write(stub("policy"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(policyMarker)}, 'spawned');\n`),
    ]);
  });

  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it("declares its kind, its capabilities and a transport core will accept", () => {
    const adapter = createClaudeCodeRuntimeAdapter({ command: "claude-test", storePath: store("selection") });
    expect(adapter.id).toBe("claude-code");
    expect(adapter.capabilities).toEqual({ skillInvocationDialect: "claude-code", ownsModelSelection: true, interactiveApprovals: false });
    expect(adapter.transport.sendPrompt).toBeTypeOf("function");
  });

  it("builds an explicit Tau permission policy and terminates options before prompt text", () => {
    expect(runtimePermissionPolicy("read-only")).toEqual({ permissionMode: "plan", tools: ["Read", "Glob", "Grep"] });
    expect(runtimePermissionPolicy("ask")).toEqual({ permissionMode: "manual", tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] });
    expect(runtimePermissionPolicy("full")).toEqual({ permissionMode: "auto", tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] });
    const args = claudeCodeArgs("123e4567-e89b-12d3-a456-426614174000", false, "--help", runtimePermissionPolicy("full"));
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("--help");
    expect(args).toContain("--tools");
    expect(args).toContain("Read,Glob,Grep,Edit,Write,Bash");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allow-dangerously-skip-permissions");
  });

  // Spawns two Node stubs; under full-suite load a stub can take seconds to start.
  it.skipIf(process.platform === "win32")("uses the selected Claude transport for every turn and preserves --help prompt text", { timeout: 60_000 }, async () => {
    const adapter = createClaudeCodeRuntimeAdapter({ command: stub("transport"), storePath: store("transport") });
    const first = await adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "session", sessionId: "provider-session", text: "--help" });
    const second = await adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "session", sessionId: "provider-session", text: "continue" });
    expect(first.assistantText).toContain("\"--help\"");
    expect(JSON.parse(second.assistantText ?? "[]")).toContain("--resume");
    expect(second.assistantText).toContain("continue");
    expect((await adapter.sessionStore?.get("session"))?.claudeSessionId).toBeTypeOf("string");
    expect(await adapter.sessionStore?.get("provider-session")).toBeUndefined();
  });

  // Spawns several Node stubs; under full-suite load a stub can take seconds to start.
  it.skipIf(process.platform === "win32")("aborts and times out tracked child processes without blocking the next turn", { timeout: 60_000 }, async () => {
    const command = stub("abort");
    const adapter = createClaudeCodeRuntimeAdapter({ command, storePath: store("abort"), timeoutMs: 30_000, killGraceMs: 20 });
    const pending = adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "abort-session", sessionId: "provider-abort", text: "hang" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const queued = adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "abort-session", sessionId: "provider-abort", text: "queued" });
    await adapter.transport.abort?.("abort-session");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "abort-session", sessionId: "provider-abort", text: "again" })).resolves.toEqual({ assistantText: "ok" });
    const timeoutAdapter = createClaudeCodeRuntimeAdapter({ command, storePath: store("timeout"), timeoutMs: 80, killGraceMs: 20 });
    await expect(timeoutAdapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "timeout-session", sessionId: "provider-timeout", text: "hang" })).rejects.toMatchObject({ name: "AbortError" });
    const controller = new AbortController();
    const signalAdapter = createClaudeCodeRuntimeAdapter({ command, storePath: store("signal"), timeoutMs: 30_000, killGraceMs: 20 });
    const signalPending = signalAdapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "signal-session", sessionId: "provider-signal", text: "hang", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(signalPending).rejects.toMatchObject({ name: "AbortError" });
  });

  // Spawns five Node stubs; under full-suite load a stub can take seconds to start.
  it.skipIf(process.platform === "win32")("recovers create/resume conflicts and one missing resumed session", { timeout: 60_000 }, async () => {
    const adapter = createClaudeCodeRuntimeAdapter({ command: stub("recovery"), storePath: store("recovery") });

    await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "conflict-session", sessionId: "provider-conflict", text: "conflict" })).resolves.toEqual({ assistantText: "resumed" });
    const conflictRecord = await adapter.sessionStore?.get("conflict-session");
    expect(conflictRecord).toMatchObject({ started: true, attempted: true, createFallbackUsed: true, attemptCount: 2 });
    await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "conflict-session", sessionId: "provider-conflict", text: "next" })).resolves.toEqual({ assistantText: "resumed" });

    await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "missing-session", sessionId: "provider-missing", text: "first" })).resolves.toEqual({ assistantText: "created" });
    await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "missing-session", sessionId: "provider-missing", text: "missing" })).resolves.toEqual({ assistantText: "created" });
    const missingRecord = await adapter.sessionStore?.get("missing-session");
    expect(missingRecord).toMatchObject({ started: true, createFallbackUsed: true, attemptCount: 3 });
  });

  // Spawns a Node stub; under full-suite load a stub can take seconds to start.
  it.skipIf(process.platform === "win32")("bounds stderr and reports its truncation marker", { timeout: 60_000 }, async () => {
    const adapter = createClaudeCodeRuntimeAdapter({ command: stub("stderr"), storePath: store("stderr"), maxBuffer: 64, killGraceMs: 20 });
    await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "stderr-session", sessionId: "provider-stderr", text: "fail" })).rejects.toThrow("Claude Code stderr truncated");
  });

  // Spawns a Node stub; under full-suite load a stub can take seconds to start.
  it.skipIf(process.platform === "win32")("bounds stdout and reports its truncation marker", { timeout: 60_000 }, async () => {
    const adapter = createClaudeCodeRuntimeAdapter({ command: stub("stdout"), storePath: store("stdout"), maxBuffer: 128, killGraceMs: 20 });
    await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "stdout-session", sessionId: "provider-stdout", text: "overflow" }))
      .rejects.toThrow("Claude Code stdout truncated");
  });

  it.skipIf(process.platform === "win32")("rejects unsupported manual policy before spawning Claude", async () => {
    const adapter = createClaudeCodeRuntimeAdapter({ command: stub("policy"), storePath: store("policy") });
    await expect(adapter.transport.sendPrompt({
      cwd: process.cwd(),
      tauThreadId: "manual-session",
      sessionId: "provider-manual",
      text: "must reject",
      permissionLevel: "ask",
    })).rejects.toThrow("manual approvals are unsupported");
    await expect(access(policyMarker)).rejects.toThrow();
  });
});
