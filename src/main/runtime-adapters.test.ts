import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertRuntimeAdapter, claudeCodeArgs, createClaudeCodeRuntimeAdapter, PI_AGENT_RUNTIME_ADAPTER, runtimePermissionPolicy, selectRuntimeAdapter } from "./runtime-adapters.js";

describe("runtime adapter selection", () => {
  it("selects the embedded Pi transport by default", () => {
    expect(selectRuntimeAdapter("pi")).toBe(PI_AGENT_RUNTIME_ADAPTER);
    expect(selectRuntimeAdapter("pi").capabilities.skillInvocationDialect).toBe("pi");
    expect(selectRuntimeAdapter("pi").transport).toBeUndefined();
  });

  it("selects a real Claude Code transport explicitly", () => {
    const adapter = selectRuntimeAdapter("claude-code");
    expect(adapter.id).toBe("claude-code");
    expect(adapter.capabilities.skillInvocationDialect).toBe("claude-code");
    expect(adapter.transport?.sendPrompt).toBeTypeOf("function");
    expect(createClaudeCodeRuntimeAdapter({ command: "claude-test" }).id).toBe("claude-code");
  });

  it("forces Pi in safe mode even when Claude was requested", () => {
    expect(selectRuntimeAdapter("claude-code", { safeMode: true })).toBe(PI_AGENT_RUNTIME_ADAPTER);
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
      const first = await adapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "session", text: "--help" });
      const second = await adapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "session", text: "continue" });
      expect(first.assistantText).toContain("\"--help\"");
      expect(JSON.parse(second.assistantText ?? "[]")).toContain("--resume");
      expect(second.assistantText).toContain("continue");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("aborts and times out tracked child processes without blocking the next turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-claude-abort-"));
    try {
      const command = join(directory, "claude-stub.mjs");
      await writeFile(command, "#!/usr/bin/env node\nconst args = process.argv.slice(2);\nif (args.at(-1) === 'hang') setInterval(() => {}, 1000); else process.stdout.write('ok');\n", { encoding: "utf8", mode: 0o700 });
      await chmod(command, 0o700);
      const adapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "sessions.json"), timeoutMs: 1000, killGraceMs: 20 });
      const pending = adapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "abort-session", text: "hang" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const queued = adapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "abort-session", text: "queued" });
      await adapter.transport.abort?.("abort-session");
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await expect(queued).rejects.toMatchObject({ name: "AbortError" });
      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "abort-session", text: "again" })).resolves.toEqual({ assistantText: "ok" });
      const timeoutAdapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "timeout-sessions.json"), timeoutMs: 80, killGraceMs: 20 });
      await expect(timeoutAdapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "timeout-session", text: "hang" })).rejects.toMatchObject({ name: "AbortError" });
      const controller = new AbortController();
      const signalAdapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "signal-sessions.json"), timeoutMs: 1_000, killGraceMs: 20 });
      const signalPending = signalAdapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "signal-session", text: "hang", signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      await expect(signalPending).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("recovers create/resume conflicts and one missing resumed session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-claude-recovery-"));
    try {
      const command = join(directory, "claude-recovery-stub.mjs");
      await writeFile(command, "#!/usr/bin/env node\nconst args = process.argv.slice(2);\nconst prompt = args.at(-1);\nif (prompt === 'conflict' && !args.includes('--resume')) { process.stderr.write('session already exists'); process.exit(2); }\nif (prompt === 'missing' && args.includes('--resume')) { process.stderr.write('session not found'); process.exit(2); }\nprocess.stdout.write(args.includes('--resume') ? 'resumed' : 'created');\n", { encoding: "utf8", mode: 0o700 });
      await chmod(command, 0o700);
      const adapter = createClaudeCodeRuntimeAdapter({ command, storePath: join(directory, "sessions.json") });

      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "conflict-session", text: "conflict" })).resolves.toEqual({ assistantText: "resumed" });
      const conflictRecord = await adapter.sessionStore?.get("conflict-session");
      expect(conflictRecord).toMatchObject({ started: true, attempted: true, createFallbackUsed: true, attemptCount: 2 });
      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "conflict-session", text: "next" })).resolves.toEqual({ assistantText: "resumed" });

      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "missing-session", text: "first" })).resolves.toEqual({ assistantText: "created" });
      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "missing-session", text: "missing" })).resolves.toEqual({ assistantText: "created" });
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
      await expect(adapter.transport.sendPrompt({ cwd: process.cwd(), sessionId: "stderr-session", text: "fail" })).rejects.toThrow("Claude Code stderr truncated");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an accidental provider-shaped adapter selection", () => {
    expect(() => selectRuntimeAdapter("anthropic")).toThrow("TAU_RUNTIME_ADAPTER");
  });

  it("rejects a dialect that does not match the selected adapter", () => {
    expect(() => assertRuntimeAdapter({ id: "pi", capabilities: { skillInvocationDialect: "claude-code" } })).toThrow("must declare");
    expect(() => assertRuntimeAdapter({ id: "claude-code", capabilities: { skillInvocationDialect: "claude-code" } })).toThrow("requires");
    expect(() => assertRuntimeAdapter({ id: "anthropic" as never, capabilities: { skillInvocationDialect: "pi" } })).toThrow("Unsupported runtime adapter");
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
        sessionId: "manual-session",
        text: "must reject",
        permissionPolicy: runtimePermissionPolicy("ask"),
      })).rejects.toThrow("manual approvals are unsupported");
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
