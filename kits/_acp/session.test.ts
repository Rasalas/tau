import { describe, expect, it } from "vitest";
import { fakeAgent } from "./fake.js";
import { AcpAgentSession, type AcpAgentSessionOptions, type AcpConfigOption } from "./session.js";

const custom = "gateway/new-model";
const modelOption: AcpConfigOption = { type: "select", id: "model-choice", category: "model", name: "Model", currentValue: "listed", options: [{ value: "listed", name: "Listed" }] };
const modeOption: AcpConfigOption = { type: "select", id: "mode", name: "Mode", currentValue: "default", options: [{ value: "default", name: "Default" }] };

describe.each(["config", "legacy"] as const)("ACP custom models through %s", (route) => {
  async function open(customModels: readonly string[] = [custom]) {
    const agent = fakeAgent();
    agent.respond("initialize", () => ({ protocolVersion: 1 }));
    agent.respond("session/new", () => ({ sessionId: "session", ...(route === "config"
      ? { configOptions: [modelOption, modeOption] }
      : { models: { currentModelId: "listed", availableModels: [{ modelId: "listed", name: "Listed" }] } }) }));
    const options: AcpAgentSessionOptions = {
      agentName: "Test runtime", process: agent.process, cwd: "/repo", clientInfo: { name: "tau", version: "1" }, clientCapabilities: {},
      onUpdate: () => undefined, onPermission: async () => ({ outcome: { outcome: "cancelled" } }), customModels,
    };
    const session = new AcpAgentSession(options);
    await session.initialize();
    await session.newSession();
    return { agent, session, method: route === "config" ? "session/set_config_option" : "session/set_model" };
  }

  it("lists configured IDs once and sends them while refusing an unconfigured typo locally", async () => {
    const { agent, session, method } = await open([custom, "listed", custom]);
    agent.respond(method, () => ({}));
    try {
      expect(session.modelOptions()).toEqual([{ value: "listed", name: "Listed" }, { value: custom, name: custom }]);
      await session.setModel(custom);
      await expect(session.setModel("gateway/typo")).rejects.toThrow(/does not offer/u);
      expect(agent.received.filter((message) => message.method === method).map((message) => message.params)).toEqual([
        route === "config" ? { sessionId: "session", configId: "model-choice", value: custom } : { sessionId: "session", modelId: custom },
      ]);
      if (route === "config") {
        await expect(session.setConfigOption("mode", custom)).rejects.toThrow(/does not offer/u);
      }
    } finally { await session.close(); }
  });

  it("preserves the agent's rejection of a configured ID", async () => {
    const { agent, session, method } = await open();
    agent.respond(method, () => ({ error: { code: -32602, message: "Gateway denied this model" } }));
    try {
      await expect(session.setModel(custom)).rejects.toThrow("Gateway denied this model");
      expect(agent.received.filter((message) => message.method === method)).toHaveLength(1);
    } finally { await session.close(); }
  });
});
