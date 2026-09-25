import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_MODEL, FAKE_PROVIDER, fakeModelsJson, fakeReply, prepareFakePiAgentDir, startFakeModelServer } from "./fake-model-server.mjs";

describe("fakeReply", () => {
  const user = (content) => ({ messages: [{ role: "system", content: "sys" }, { role: "user", content }] });

  it("writes, waits or says ok, from the last user message", () => {
    expect(fakeReply(user("Please write notes/a.txt hello"))).toEqual({ toolCall: { name: "write", arguments: { path: "notes/a.txt", content: "hello\n" } } });
    expect(fakeReply(user([{ type: "text", text: "wait 1500" }]))).toEqual({ text: "ok", waitMs: 1500 });
    expect(fakeReply(user("Reply with one word"))).toEqual({ text: "ok" });
    expect(fakeReply(user("fail 400 Unsupported parameter: temperature"))).toEqual({ status: 400, error: "Unsupported parameter: temperature" });
    expect(fakeReply({ messages: [...user("write a b").messages, { role: "assistant", content: null }, { role: "tool", content: "ok" }] })).toEqual({ text: "done" });
  });
});

describe("startFakeModelServer", () => {
  let server;
  beforeAll(async () => { server = await startFakeModelServer(); });
  afterAll(async () => { await server.close(); });

  const model = () => {
    const [entry] = fakeModelsJson(server.baseUrl).providers[FAKE_PROVIDER].models;
    return { ...entry, api: "openai-completions", provider: FAKE_PROVIDER, baseUrl: server.baseUrl };
  };
  const ask = (text) => complete(model(), { messages: [{ role: "user", content: text, timestamp: Date.now() }] }, { apiKey: "fake" });

  it("streams a text answer Pi reads, with usage and a cost", async () => {
    const message = await ask("Reply with one word");
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "ok" })]);
    expect(message.usage.output).toBe(5);
    expect(message.usage.cost.total).toBeGreaterThan(0);
    expect(server.requests.at(-1).model).toBe(FAKE_MODEL);
  });

  it("holds a wait until the caller aborts", async () => {
    const controller = new AbortController();
    const reply = complete(model(), { messages: [{ role: "user", content: "wait 60000", timestamp: Date.now() }] }, { apiKey: "fake", signal: controller.signal });
    const asked = server.requests.length;
    while (server.requests.length === asked) await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const message = await reply;
    expect(message.stopReason).toBe("aborted");
  });

  it("refuses a request with the status and text asked for", async () => {
    const message = await ask("fail 400 Unsupported parameter: temperature");
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("Unsupported parameter: temperature");
  });

  it("streams a write tool call", async () => {
    const message = await ask("write result.txt done");
    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([expect.objectContaining({ type: "toolCall", name: "write", arguments: { path: "result.txt", content: "done\n" } })]);
  });
});

describe("prepareFakePiAgentDir", () => {
  it("knows only the fake and picks it by default", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "tau-fake-agent-")), "pi-agent");
    prepareFakePiAgentDir(dir, "http://127.0.0.1:1/v1");
    expect(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"))).toEqual({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL });
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers)).toEqual([FAKE_PROVIDER]);
  });
});
