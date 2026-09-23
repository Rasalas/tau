import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { claudeProjectDirs, parseClaudeSession } from "./history-import.js";
import createClaudeCodeHostExtension from "./host.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const ALPHA = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString();

/** A session the way the CLI writes it: one entry per content block, tools and side chains between. */
function alphaLines(cwd: string): string[] {
  const base = { sessionId: ALPHA, cwd, isSidechain: false, userType: "external" };
  return [
    { type: "summary", summary: "Fix the flaky login test", leafUuid: "x" },
    { ...base, type: "user", timestamp: at(0), message: { role: "user", content: "The login test fails on CI.\nCan you look?" } },
    { ...base, type: "assistant", timestamp: at(1), message: { role: "assistant", model: "claude-test-1", content: [{ type: "thinking", thinking: "hmm" }] } },
    { ...base, type: "assistant", timestamp: at(1), message: { role: "assistant", model: "claude-test-1", content: [{ type: "text", text: "Reading the test first." }] } },
    { ...base, type: "assistant", timestamp: at(1), message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
    { ...base, type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file" }] } },
    { ...base, type: "assistant", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "It waits on a timer; fixed." }] } },
    { ...base, type: "user", isSidechain: true, timestamp: at(3), message: { role: "user", content: "sub-agent prompt" } },
    { ...base, type: "user", isMeta: true, timestamp: at(3), message: { role: "user", content: "Caveat: local commands" } },
    { ...base, type: "user", timestamp: at(3), message: { role: "user", content: "<command-name>/clear</command-name>" } },
    { ...base, type: "user", timestamp: at(4), message: { role: "user", content: [{ type: "text", text: "Thanks!" }] } },
    "{ torn line",
  ].map((line) => typeof line === "string" ? line : JSON.stringify(line));
}

async function home() {
  const root = await mkdtemp(join(tmpdir(), "tau-claude-import-"));
  directories.push(root);
  const project = join(root, "claude-code", "projects", "-work-alpha");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${ALPHA}.jsonl`), `${alphaLines("/work/alpha").join("\n")}\n`);
  await writeFile(join(project, `${BETA}.jsonl`), `${JSON.stringify({ type: "user", sessionId: BETA, cwd: "/work/alpha", timestamp: at(5), message: { role: "user", content: "Second session" } })}\n`);
  // Neither a session file name nor a conversation: both are passed over.
  await writeFile(join(project, "notes.jsonl"), "{}\n");
  await writeFile(join(project, "33333333-3333-4333-8333-333333333333.jsonl"), `${JSON.stringify({ type: "summary", summary: "empty" })}\n`);
  return root;
}

async function harness(root: string) {
  const backends: HostRuntimeBackendProvider[] = [];
  const refreshIndex = vi.fn(async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }));
  const registry = await activateHostKit(createClaudeCodeHostExtension({ env: { TAU_IMPORT_ROOTS: root } }), {
    stateDir: join(root, "state"),
    sessionsDir: join(root, "agent", "sessions"),
    findCommand: () => "/usr/local/bin/claude",
    sessions: { refreshIndex } as never,
    registerRuntimeBackend: (provider) => { backends.push(provider); return () => undefined; },
  });
  return { registry, provider: backends[0]!, refreshIndex };
}

describe("Claude Code session import", () => {
  it("keeps the visible conversation and passes over tools, thinking, side chains and command echoes", () => {
    const parsed = parseClaudeSession(alphaLines("/work/alpha"), { updatedAt: 0 });
    expect(parsed).toMatchObject({ sessionId: ALPHA, cwd: "/work/alpha", title: "Fix the flaky login test", model: "claude-test-1" });
    expect(parsed?.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "The login test fails on CI.\nCan you look?"],
      ["assistant", "Reading the test first.\n\nIt waits on a timer; fixed."],
      ["user", "Thanks!"],
    ]);
    expect(parsed?.messages[0]?.timestamp).toBe(Date.parse(at(0)));
  });

  it("reads fixture homes from TAU_IMPORT_ROOTS and the CLI's own home otherwise", () => {
    expect(claudeProjectDirs({ TAU_IMPORT_ROOTS: "/fixtures" })).toEqual(["/fixtures/claude-code/projects"]);
    expect(claudeProjectDirs({ CLAUDE_CONFIG_DIR: "/cfg" })).toEqual(["/cfg/projects"]);
  });

  it("lists the sessions of the home, imports them as threads and adds nothing the second time", async () => {
    const root = await home();
    const { registry, provider, refreshIndex } = await harness(root);
    const scan = await registry.invoke("tau.claude-code", "import-scan") as { source: string; sessions: Array<{ path: string; sessionId: string; title: string; imported: boolean }> };
    expect(scan.source).toBe("claude-code");
    expect(scan.sessions.map((session) => [session.sessionId, session.title, session.imported]).sort()).toEqual([
      [ALPHA, "Fix the flaky login test", false],
      [BETA, "Second session", false],
    ]);

    const paths = scan.sessions.map((session) => session.path);
    const first = await registry.invoke("tau.claude-code", "import-sessions", { paths: [...paths, "/etc/passwd.jsonl"] }) as { imported: string[]; skipped: number; failed: Array<{ path: string }>; update?: unknown };
    expect(first.imported).toHaveLength(2);
    expect(first.skipped).toBe(0);
    expect(first.failed.map((entry) => entry.path)).toEqual(["/etc/passwd.jsonl"]);
    expect(first.update).toMatchObject({ type: "thread-index" });

    const threads = await provider.listThreads();
    const alpha = threads.find((thread) => thread.title === "Fix the flaky login test");
    expect(alpha).toMatchObject({ cwd: "/work/alpha" });
    expect(alpha?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);

    const second = await registry.invoke("tau.claude-code", "import-sessions", { paths }) as { imported: string[]; skipped: number; update?: unknown };
    expect(second).toMatchObject({ imported: [], skipped: 2 });
    expect(second.update).toBeUndefined();
    expect(refreshIndex).toHaveBeenCalledTimes(1);
    expect(await provider.listThreads()).toHaveLength(2);
    const rescan = await registry.invoke("tau.claude-code", "import-scan") as { sessions: Array<{ imported: boolean }> };
    expect(rescan.sessions.every((session) => session.imported)).toBe(true);
  });
});
