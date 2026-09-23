import { describe, expect, it } from "vitest";
import { fakeAgent, until, type FakeAgent } from "../_acp/fake.js";
import { USAGE_LIMIT_MESSAGE, openGrokSession, type GrokSession } from "./session.js";

async function open(agent: FakeAgent, env: NodeJS.ProcessEnv = {}, cancelMs = 50): Promise<GrokSession> {
  agent.respond("initialize", () => ({ protocolVersion: 1, authMethods: [{ id: "cached_token", name: "Grok" }, { id: "xai.api_key", name: "Key" }], agentCapabilities: { loadSession: true } }));
  agent.respond("authenticate", () => ({}));
  agent.respond("session/new", () => ({ sessionId: "s1", models: { currentModelId: "grok-4.6", availableModels: [{ modelId: "grok-4.6", name: "Grok 4.6" }] } }));
  const session = await openGrokSession({ command: "grok", args: ["agent", "stdio"], cwd: "/repo", env, clientVersion: "1.0.0", spawn: () => agent.process, onUpdate: () => undefined, onPermission: async () => ({ outcome: { outcome: "cancelled" } }), timeouts: { cancelMs } });
  await session.newSession();
  return session;
}

/** The n-th `session/prompt` Tau sent; the fake may have read it before a waiter could register. */
async function promptRequest(agent: FakeAgent, n = 1): Promise<Record<string, unknown>> {
  const prompts = () => agent.received.filter((message) => message.method === "session/prompt");
  await until(() => prompts().length >= n);
  return prompts()[n - 1]!;
}

const complete = (agent: FakeAgent, params: object) => agent.send({ jsonrpc: "2.0", method: "_x.ai/session/prompt_complete", params: { sessionId: "s1", ...params } });

describe("GrokSession", () => {
  it("signs in with the CLI's login, or with the API key when Tau's environment has one", async () => {
    const agent = fakeAgent();
    await open(agent);
    expect(agent.received.find((message) => message.method === "authenticate")?.params).toEqual({ methodId: "cached_token" });
    const keyed = fakeAgent();
    await open(keyed, { XAI_API_KEY: "xai-1" });
    expect(keyed.received.find((message) => message.method === "authenticate")?.params).toEqual({ methodId: "xai.api_key" });
  });

  it("ends a prompt on xAI's completion notification when the answer never comes, and prompts again after", async () => {
    const agent = fakeAgent();
    const session = await open(agent);
    const first = session.prompt([{ type: "text", text: "hi" }]);
    const request = await promptRequest(agent);
    const promptId = (request.params as { _meta: { promptId: string; requestId: string } })["_meta"].promptId;
    expect((request.params as { _meta: { requestId: string } })["_meta"].requestId).toBe(promptId);
    complete(agent, { promptId: "someone-else", stopReason: "end_turn" });
    complete(agent, { promptId, stopReason: "max_tokens" });
    await expect(first).resolves.toEqual({ stopReason: "max_tokens" });
    // The notification came again, late: it ends nothing.
    complete(agent, { promptId, stopReason: "end_turn" });
    agent.respond("session/prompt", () => ({ stopReason: "end_turn" }));
    await expect(session.prompt([{ type: "text", text: "again" }])).resolves.toEqual({ stopReason: "end_turn" });
    await session.close();
  });

  it("fails a prompt that ran into the plan's limit or an error", async () => {
    const agent = fakeAgent();
    const session = await open(agent);
    const limited = session.prompt([{ type: "text", text: "hi" }]);
    const first = await promptRequest(agent);
    complete(agent, { promptId: (first.params as { _meta: { promptId: string } })["_meta"].promptId, stopReason: "rate_limit" });
    await expect(limited).rejects.toThrow(USAGE_LIMIT_MESSAGE);
    const failed = session.prompt([{ type: "text", text: "hi" }]);
    await promptRequest(agent, 2);
    complete(agent, { stopReason: "error", agentResult: { message: "model overloaded" } });
    await expect(failed).rejects.toThrow("model overloaded");
    agent.respond("session/prompt", () => ({ error: { code: -32003, message: "rate limited" } }));
    await expect(session.prompt([{ type: "text", text: "hi" }])).rejects.toThrow(USAGE_LIMIT_MESSAGE);
    await session.close();
  });

  it("counts a prompt Grok does not answer after a cancel as cancelled, and keeps the process", async () => {
    const agent = fakeAgent();
    const session = await open(agent, {}, 5_000);
    const running = session.prompt([{ type: "text", text: "work" }]);
    await promptRequest(agent);
    const started = Date.now();
    await session.cancel();
    await expect(running).resolves.toEqual({ stopReason: "cancelled" });
    expect(Date.now() - started).toBeLessThan(4_000);
    await until(() => agent.received.some((message) => message.method === "session/cancel"));
    expect(session.closed).toBe(false);
    await session.close();
  });
});
