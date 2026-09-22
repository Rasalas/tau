import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { codexSessionDirs, parseCodexSession } from "./history-import.js";
import createCodexHostExtension from "./host.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

const ALPHA = "0199aaaa-1111-7111-8111-111111111111";
const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 10, minute)).toISOString();
const line = (minute: number, type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: at(minute), type, payload });
const item = (role: string, kind: string, text: string) => ({ type: "message", role, content: [{ type: kind, text }] });

/** A current rollout: every prompt as a response item and an event, every reply likewise. */
function currentRollout(cwd: string): string[] {
  return [
    line(0, "session_meta", { id: ALPHA, cwd, originator: "codex_cli_rs", cli_version: "0.155.0", base_instructions: { text: "You are Codex." } }),
    line(0, "response_item", item("user", "input_text", `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>`)),
    line(0, "response_item", item("user", "input_text", "Add a --json flag")),
    line(0, "event_msg", { type: "user_message", message: "Add a --json flag", images: [] }),
    line(0, "turn_context", { cwd, model: "gpt-test", approval_policy: "on-request" }),
    line(1, "response_item", { type: "reasoning", summary: [] }),
    line(1, "response_item", { type: "function_call", name: "shell", arguments: "{}" }),
    line(2, "response_item", item("assistant", "output_text", "Added the flag.")),
    line(2, "event_msg", { type: "agent_message", message: "Added the flag." }),
    line(3, "event_msg", { type: "user_message", message: "And a test?" }),
    line(3, "response_item", item("user", "input_text", "And a test?")),
    line(4, "response_item", item("assistant", "output_text", "Done.")),
  ];
}

/** An older rollout had response items only. */
function legacyRollout(cwd: string): string[] {
  return [
    line(0, "session_meta", { id: "legacy-id", cwd }),
    line(0, "response_item", item("user", "input_text", "<user_instructions>be brief</user_instructions>")),
    line(0, "response_item", item("user", "input_text", "Rename the module")),
    line(1, "response_item", item("assistant", "output_text", "Renamed.")),
  ];
}

async function home() {
  const root = await mkdtemp(join(tmpdir(), "tau-codex-import-"));
  directories.push(root);
  const day = join(root, "codex", "sessions", "2026", "09", "20");
  await mkdir(day, { recursive: true });
  await writeFile(join(day, `rollout-2026-09-20T10-00-00-${ALPHA}.jsonl`), `${currentRollout("/work/alpha").join("\n")}\n`);
  await writeFile(join(day, "rollout-2026-09-20T11-00-00-legacy.jsonl"), `${legacyRollout("/work/beta").join("\n")}\n`);
  await writeFile(join(day, "rollout-2026-09-20T12-00-00-empty.jsonl"), `${line(0, "session_meta", { id: "empty", cwd: "/work/beta" })}\n`);
  await writeFile(join(day, "history.jsonl"), "{}\n");
  return root;
}

async function harness(root: string) {
  const backends: HostRuntimeBackendProvider[] = [];
  const refreshIndex = vi.fn(async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }));
  const registry = await activateHostKit(createCodexHostExtension({ env: { TAU_IMPORT_ROOTS: root }, readVersion: async () => "0.155.0" }), {
    stateDir: join(root, "state"),
    sessionsDir: join(root, "agent", "sessions"),
    findCommand: () => "/usr/local/bin/codex",
    noteSubprocess: () => undefined,
    sessions: { refreshIndex } as never,
    registerRuntimeBackend: (provider) => { backends.push(provider); return () => undefined; },
  });
  return { registry, provider: backends[0]!, refreshIndex };
}

describe("Codex session import", () => {
  it("takes the user's words from the events and the replies from the response items", () => {
    const parsed = parseCodexSession(currentRollout("/work/alpha"), 0);
    expect(parsed).toMatchObject({ sessionId: ALPHA, cwd: "/work/alpha", title: "Add a --json flag", model: "gpt-test" });
    expect(parsed?.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Add a --json flag"],
      ["assistant", "Added the flag."],
      ["user", "And a test?"],
      ["assistant", "Done."],
    ]);
  });

  it("reads an older rollout from its response items, without the generated context", () => {
    expect(parseCodexSession(legacyRollout("/work/beta"), 0)?.messages.map((message) => message.text)).toEqual(["Rename the module", "Renamed."]);
  });

  it("reads fixture homes from TAU_IMPORT_ROOTS and CODEX_HOME otherwise", () => {
    expect(codexSessionDirs({ TAU_IMPORT_ROOTS: "/fixtures" })).toEqual(["/fixtures/codex/sessions"]);
    expect(codexSessionDirs({ CODEX_HOME: "/shadow" })).toEqual(["/shadow/sessions"]);
  });

  it("lists the rollouts, imports them as threads that resume by Codex's id and adds nothing the second time", async () => {
    const root = await home();
    const { registry, provider, refreshIndex } = await harness(root);
    const scan = await registry.invoke("tau.codex", "import-scan") as { source: string; sessions: Array<{ path: string; sessionId: string; cwd: string; imported: boolean }> };
    expect(scan.source).toBe("codex");
    expect(scan.sessions.map((session) => [session.sessionId, session.cwd, session.imported]).sort()).toEqual([
      [ALPHA, "/work/alpha", false],
      ["legacy-id", "/work/beta", false],
    ]);

    const paths = scan.sessions.map((session) => session.path);
    const first = await registry.invoke("tau.codex", "import-sessions", { paths }) as { imported: string[]; skipped: number };
    expect(first).toMatchObject({ skipped: 0 });
    expect(first.imported).toHaveLength(2);
    const threads = await provider.listThreads();
    expect(threads.map((thread) => thread.title).sort()).toEqual(["Add a --json flag", "Rename the module"]);

    const second = await registry.invoke("tau.codex", "import-sessions", { paths }) as { imported: string[]; skipped: number };
    expect(second).toMatchObject({ imported: [], skipped: 2 });
    expect(refreshIndex).toHaveBeenCalledTimes(1);
    expect(await provider.listThreads()).toHaveLength(2);
  });
});
