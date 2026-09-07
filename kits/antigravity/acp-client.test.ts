import { describe, expect, it, vi } from "vitest";
import { AcpClient, AcpRequestError, lineSplitter } from "./acp-client.js";
import { fakeAgent, until } from "./acp-fake.js";

describe("AcpClient", () => {
  it("sends requests with ids and notifications without, and matches answers", async () => {
    const agent = fakeAgent();
    const notifications: Array<[string, unknown]> = [];
    const client = new AcpClient({ process: agent.process, onNotification: (method, params) => notifications.push([method, params]) });
    agent.respond("initialize", (params) => ({ protocolVersion: (params as { protocolVersion: number }).protocolVersion, agentInfo: { name: "antigravity-acp" } }));
    const answer = await client.request<{ agentInfo: { name: string } }>("initialize", { protocolVersion: 1 });
    expect(answer.agentInfo.name).toBe("antigravity-acp");
    client.notify("session/cancel", { sessionId: "s" });
    await until(() => agent.received.length === 2);
    expect(agent.received[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(agent.received[1]).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } });
    expect("id" in agent.received[1]!).toBe(false);
    agent.send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "plan" } } });
    await until(() => notifications.length === 1);
    expect(notifications[0]).toEqual(["session/update", { sessionId: "s", update: { sessionUpdate: "plan" } }]);
  });

  it("serves the agent's requests through handlers and answers unknown methods with -32601", async () => {
    const agent = fakeAgent();
    const client = new AcpClient({ process: agent.process, onNotification: () => undefined });
    client.handle("session/request_permission", async (params) => ({ outcome: { outcome: "selected", optionId: (params as { options: Array<{ optionId: string }> }).options[0]!.optionId } }));
    agent.send({ jsonrpc: "2.0", id: 7, method: "session/request_permission", params: { options: [{ optionId: "allow" }] } });
    agent.send({ jsonrpc: "2.0", id: 8, method: "terminal/create", params: {} });
    await until(() => agent.received.length === 2);
    expect(agent.received.find((message) => message.id === 7)).toEqual({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "allow" } } });
    expect(agent.received.find((message) => message.id === 8)).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "Method not found: terminal/create" } });
  });

  it("turns error answers into AcpRequestError and fails pending requests when the process exits", async () => {
    const agent = fakeAgent();
    const onExit = vi.fn();
    const client = new AcpClient({ process: agent.process, onNotification: () => undefined, onExit });
    agent.respond("session/new", () => ({ error: { code: -32000, message: "Sign in first." } }));
    await expect(client.request("session/new", {})).rejects.toMatchObject({ name: "AcpRequestError", code: -32000, message: "Sign in first." });
    const hanging = client.request("session/prompt", {});
    agent.stderr("boom");
    agent.exit(1);
    await expect(hanging).rejects.toThrow(/exited with code 1[\s\S]*boom/u);
    expect(onExit).toHaveBeenCalledWith(expect.objectContaining({ name: "AcpExitedError" }));
    expect(client.closed).toBe(true);
    await expect(client.request("initialize", {})).rejects.toBeInstanceOf(Error);
  });

  it("hands non-JSON stdout lines to the hook and honours a request timeout", async () => {
    const agent = fakeAgent();
    const seen: string[] = [];
    const client = new AcpClient({ process: agent.process, onNotification: () => undefined, onStdoutLine: (line) => { seen.push(line); return true; } });
    agent.sendRaw("Open the following link to authenticate the ACP server: https://accounts.google.com/x");
    await until(() => seen.length === 1);
    await expect(client.request("initialize", {}, { timeoutMs: 20 })).rejects.toBeInstanceOf(AcpRequestError);
  });

  it("closes by ending stdin and kills a process that lingers", async () => {
    const agent = fakeAgent();
    const client = new AcpClient({ process: agent.process, onNotification: () => undefined });
    await client.close(10);
    expect(client.closed).toBe(true);
  });

  it("splits lines across chunks and drops one that grows past the limit", () => {
    const lines: string[] = [];
    const overflow = vi.fn();
    const feed = lineSplitter(8, (line) => lines.push(line), overflow);
    feed(Buffer.from("ab"));
    feed(Buffer.from("c\nlong-line-that-overflows"));
    feed(Buffer.from("\nok\n"));
    expect(lines).toEqual(["abc", "ok"]);
    expect(overflow).toHaveBeenCalledTimes(1);
  });
});
