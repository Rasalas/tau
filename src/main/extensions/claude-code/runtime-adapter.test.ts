import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER, selectDefaultBackend } from "../../runtime-adapters.js";
import { claudeCodeArgs, createClaudeCodeRuntimeAdapter, runtimePermissionPolicy } from "./runtime-adapter.js";

describe("runtime adapter selection", () => {
  it("runs Pi unless the environment names another backend", () => {
    expect(selectDefaultBackend("pi")).toBe("pi");
    expect(selectDefaultBackend(undefined)).toBe("pi");
    expect(PI_AGENT_RUNTIME_ADAPTER.capabilities.skillInvocationDialect).toBe("pi");
    expect(PI_AGENT_RUNTIME_ADAPTER.transport).toBeUndefined();
  });

  it("names the Claude Code backend explicitly and builds its transport", () => {
    expect(selectDefaultBackend(" Claude-Code ")).toBe("claude-code");
    const adapter = createClaudeCodeRuntimeAdapter({ command: "claude-test" });
    expect(adapter.id).toBe("claude-code");
    expect(adapter.capabilities).toEqual({ skillInvocationDialect: "claude-code", ownsModelSelection: true, interactiveApprovals: false });
    expect(adapter.transport.sendPrompt).toBeTypeOf("function");
    expect(assertRuntimeAdapter(adapter)).toBe(adapter);
  });

  it("forces Pi in safe mode even when Claude was requested", () => {
    expect(selectDefaultBackend("claude-code", { safeMode: true })).toBe("pi");
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

  it.skipIf(process.platform === "win32")("uses the selected Claude transport for every turn and preserves --help prompt text", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-claude-adapter-"));
    try {
      const command = join(directory, "claude-stub.mjs");
      await writeFile(command, "#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args.at(-1) === 'hang') setInterval(() => {}, 1000); else process.stdout.write(JSON.stringify(args));\n", { encoding: "utf8", mode: 0o700 });
      await chmod(command, 0o700);
      const adapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "sessions.json") });
      const first = await adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "session", sessionId: "provider-session", text: "--help" });
      const second = await adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "session", sessionId: "provider-session", text: "continue" });
      expect(first.assistantText).toContain("\"--help\"");
      expect(JSON.parse(second.assistantText ?? "[]")).toContain("--resume");
      expect(second.assistantText).toContain("continue");
      expect((await adapter.sessionStore?.get("session"))?.claudeSessionId).toBeTypeOf("string");
      expect(await adapter.sessionStore?.get("provider-session")).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Spawns several Node stubs; under full-suite load a stub can take seconds to start.
  it.skipIf(process.platform === "win32")("aborts and times out tracked child processes without blocking the next turn", { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-claude-abort-"));
    try {
      const command = join(directory, "claude-stub.mjs");
      await writeFile(command, "#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args.at(-1) === 'hang') setInterval(() => {}, 1000); else process.stdout.write('ok');\n", { encoding: "utf8", mode: 0o700 });
      await chmod(command, 0o700);
      const adapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "sessions.json"), timeoutMs: 30_000, killGraceMs: 20 });
      const pending = adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "abort-session", sessionId: "provider-abort", text: "hang" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const queued = adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "abort-session", sessionId: "provider-abort", text: "queued" });
      await adapter.transport.abort?.("abort-session");
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await expect(queued).rejects.toMatchObject({ name: "AbortError" });
      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "abort-session", sessionId: "provider-abort", text: "again" })).resolves.toEqual({ assistantText: "ok" });
      const timeoutAdapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "timeout-sessions.json"), timeoutMs: 80, killGraceMs: 20 });
      await expect(timeoutAdapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "timeout-session", sessionId: "provider-timeout", text: "hang" })).rejects.toMatchObject({ name: "AbortError" });
      const controller = new AbortController();
      const signalAdapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "signal-sessions.json"), timeoutMs: 30_000, killGraceMs: 20 });
      const signalPending = signalAdapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "signal-session", sessionId: "provider-signal", text: "hang", signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await expect(signalPending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("recovers create/resume conflicts and one missing resumed session", { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-claude-recovery-"));
    try {
      const command = join(directory, "claude-recovery-stub.mjs");
      await writeFile(command, "#!/usr/bin/env node\nconst args = process.argv.slice(2);\nconst prompt = args.at(-1);\nif (prompt === 'conflict' && !args.includes('--resume')) { process.stderr.write('session already exists'); process.exit(2); }\nif (prompt === 'missing' && args.includes('--resume')) { process.stderr.write('session not found'); process.exit(2); }\nprocess.stdout.write(args.includes('--resume') ? 'resumed' : 'created');\n", { encoding: "utf8", mode: 0o700 });
      await chmod(command, 0o700);
      const adapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "sessions.json") });

      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "conflict-session", sessionId: "provider-conflict", text: "conflict" })).resolves.toEqual({ assistantText: "resumed" });
      const conflictRecord = await adapter.sessionStore?.get("conflict-session");
      expect(conflictRecord).toMatchObject({ started: true, attempted: true, createFallbackUsed: true, attemptCount: 2 });
      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "conflict-session", sessionId: "provider-conflict", text: "next" })).resolves.toEqual({ assistantText: "resumed" });

      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "missing-session", sessionId: "provider-missing", text: "first" })).resolves.toEqual({ assistantText: "created" });
      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "missing-session", sessionId: "provider-missing", text: "missing" })).resolves.toEqual({ assistantText: "created" });
      const missingRecord = await adapter.sessionStore?.get("missing-session");
      expect(missingRecord).toMatchObject({ started: true, createFallbackUsed: true, attemptCount: 3 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("bounds stderr and reports its truncation marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-claude-stderr-"));
    try {
      const command = join(directory, "claude-stderr-stub.mjs");
      await writeFile(command, "#!/usr/bin/env node\nprocess.stderr.write('e'.repeat(200)); process.exit(2);\n", { encoding: "utf8", mode: 0o700 });
      await chmod(command, 0o700);
      const adapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "sessions.json"), maxBuffer: 64, killGraceMs: 20 });
      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "stderr-session", sessionId: "provider-stderr", text: "fail" })).rejects.toThrow("Claude Code stderr truncated");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("bounds stdout and reports its truncation marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-claude-stdout-"));
    try {
      const command = join(directory, "claude-stdout-stub.mjs");
      await writeFile(command, "#!/usr/bin/env node\nprocess.stdout.write('o'.repeat(200)); setInterval(() => {}, 1000);\n", { encoding: "utf8", mode: 0o700 });
      await chmod(command, 0o700);
      const adapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "sessions.json"), maxBuffer: 128, killGraceMs: 20 });
      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), tauThreadId: "stdout-session", sessionId: "provider-stdout", text: "overflow" }))
        .rejects.toThrow("Claude Code stdout truncated");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an adapter whose shape does not fit its kind", () => {
    expect(() => assertRuntimeAdapter({ id: "pi", capabilities: { skillInvocationDialect: "claude-code" } })).toThrow("must declare");
    expect(() => assertRuntimeAdapter({ id: "claude-code", capabilities: { skillInvocationDialect: "claude-code" } })).toThrow("requires");
    // A provider name is not a backend; without a transport it is refused where it would be used.
    expect(() => assertRuntimeAdapter({ id: "anthropic", capabilities: { skillInvocationDialect: "pi" } })).toThrow("requires a configured transport");
    expect(() => assertRuntimeAdapter({ id: "", capabilities: { skillInvocationDialect: "pi" } })).toThrow("Unsupported runtime adapter");
  });

  it.skipIf(process.platform === "win32")("rejects unsupported manual policy before spawning Claude", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-claude-policy-"));
    try {
      const marker = join(directory, "spawned");
      const command = join(directory, "claude-policy-stub.mjs");
      await writeFile(command, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'spawned');\n`, { encoding: "utf8", mode: 0o700 });
      await chmod(command, 0o700);
      const adapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "sessions.json") });
      await expect(adapter.transport.sendPrompt({
        cwd: process.cwd(),
        tauThreadId: "manual-session",
        sessionId: "provider-manual",
        text: "must reject",
        permissionLevel: "ask",
      })).rejects.toThrow("manual approvals are unsupported");
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
