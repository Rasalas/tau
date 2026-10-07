import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRuntimeEvent } from "tau/host-extension";
import { createClaudeCodeRuntimeAdapter, type ClaudeSessionInput } from "./runtime-adapter.js";
import type { ClaudeSdkSession, ResultMessage, UserContent } from "./sdk-session.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";
import { ClaudeThreadRuntimeBackend } from "./thread-backend.js";

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const frame = <T extends object>(value: T): SDKMessage => ({ uuid: "u", session_id: SESSION, ...value }) as unknown as SDKMessage;
const result = (text: string) => frame({
  type: "result", subtype: "success", is_error: false, num_turns: 1, result: text, total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: {},
}) as ResultMessage;
/** `SDKActiveGoalMessage` (sdk.d.ts, 0.3.263): what the CLI's `/goal` check reports. */
const activeGoal = (value: { condition: string; iterations: number; last_reason?: string } | null) => frame({ type: "active_goal", value: value ? { set_at: 1, tokens_at_start: 0, ...value } : null });

const dirs: string[] = [];
const backends: ClaudeThreadRuntimeBackend[] = [];
afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Each sent text answers with the frames `script` names, then its result. */
async function open(script: (text: string) => SDKMessage[]) {
  const dir = await mkdtemp(join(tmpdir(), "tau-claude-goals-"));
  dirs.push(dir);
  const filePath = join(dir, "sessions.json");
  const store = new ClaudeRuntimeSessionStore({ filePath });
  const adapter = createClaudeCodeRuntimeAdapter({ command: "unused", storePath: filePath });
  const sent: string[] = [];
  adapter.openSession = vi.fn((input: ClaudeSessionInput) => {
    let closed = false;
    const session = {
      get busy() { return false; },
      get closed() { return closed; },
      send: vi.fn(async (content: UserContent) => {
        const text = typeof content === "string" ? content : JSON.stringify(content);
        sent.push(text);
        const frames = [...script(text), result("ok")];
        for (const message of frames) input.onMessage(message);
        return frames.at(-1) as ResultMessage;
      }),
      interrupt: vi.fn(async () => undefined),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setEffort: vi.fn(async () => undefined),
      supportedModels: vi.fn(async () => []),
      close: vi.fn(async () => { closed = true; input.onExit(undefined); }),
    };
    return session as unknown as ClaudeSdkSession;
  });
  const events: ThreadRuntimeEvent[] = [];
  const backend = new ClaudeThreadRuntimeBackend("tau-1", "/repo", { adapter, store, projectName: "repo", onEvent: (event) => events.push(event) });
  backends.push(backend);
  await backend.start("create");
  return { backend, events, sent, store };
}

describe("Claude Code goals", () => {
  it("sets a goal with the CLI's own /goal as the first prompt and follows its check", async () => {
    const { backend, sent } = await open((text) => text.startsWith("/goal ")
      ? [activeGoal({ condition: "tests pass", iterations: 0 }), activeGoal({ condition: "tests pass", iterations: 2, last_reason: "2 tests still fail" })]
      : []);
    const goals = backend.capabilities.goals!;
    await expect(goals.set("tests pass")).resolves.toEqual({ prompt: "/goal tests pass" });
    await backend.prompt({ text: "/goal tests pass", delivery: "prompt" });
    expect(sent).toContain("/goal tests pass");
    expect(goals.current()).toMatchObject({ objective: "tests pass", status: "active", turns: 2, reason: "2 tests still fail", actions: { pause: false, resume: false } });
    await expect(goals.pause()).rejects.toThrow(/cannot pause/u);
  });

  it("never shows a goal the check cleared as met: Claude clears it the same way after a timeout", async () => {
    const { backend } = await open((text) => text.startsWith("/goal ")
      ? [activeGoal({ condition: "ship", iterations: 1 }), activeGoal(null)]
      : []);
    await backend.prompt({ text: "/goal ship", delivery: "prompt" });
    const goal = backend.capabilities.goals!.current();
    expect(goal).toMatchObject({ objective: "ship", status: "unconfirmed", actions: { resume: true } });
    await expect(backend.capabilities.goals!.resume()).resolves.toEqual({ prompt: "/goal ship" });
    await backend.capabilities.goals!.dismiss!();
    expect(backend.capabilities.goals!.current()).toBeUndefined();
  });

  it("ends a goal with /goal clear as a turn of its own, and reads the cleared frame as the user's end", async () => {
    const { backend, sent, events } = await open((text) => text === "/goal clear" ? [activeGoal(null)] : text.startsWith("/goal ") ? [activeGoal({ condition: "ship", iterations: 0 })] : []);
    await backend.prompt({ text: "/goal ship", delivery: "prompt" });
    await backend.capabilities.goals!.clear();
    expect(sent.at(-1)).toBe("/goal clear");
    expect(backend.capabilities.goals!.current()).toBeUndefined();
    // The clear is no message of the user's.
    expect((await backend.transcript()).filter((message) => message.role === "user").map((message) => message.text)).toEqual(["/goal ship"]);
    expect(events).toContainEqual({ type: "goal" });
  });

  it("keeps a stop's or a restart's line in the transcript as nobody's message", async () => {
    const { backend } = await open(() => []);
    await backend.capabilities.resume!.notice!("Stopped · goal paused. Nothing wakes this thread until you start it again.");
    expect((await backend.transcript()).map((message) => [message.role, message.text])).toEqual([["notice", "Stopped · goal paused. Nothing wakes this thread until you start it again."]]);
  });

  it("shows a goal active before a restart as not confirmed: Tau cannot tell whether Claude still holds it", async () => {
    const { store } = await open(() => []);
    await store.setGoal("tau-1", "/repo", { condition: "ship", status: "active", iterations: 4, updatedAt: 1 });
    const adapter = createClaudeCodeRuntimeAdapter({ command: "unused", storePath: "unused" });
    const events: ThreadRuntimeEvent[] = [];
    const restarted = new ClaudeThreadRuntimeBackend("tau-1", "/repo", { adapter, store, projectName: "repo", onEvent: (event) => events.push(event) });
    backends.push(restarted);
    await restarted.start("resume");
    expect(restarted.capabilities.goals!.current()).toMatchObject({ status: "unconfirmed", turns: 4, reason: expect.stringContaining("/goal clear") });
    expect(events).toContainEqual({ type: "goal" });
  });
});
