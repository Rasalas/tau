import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ComputerUseDriverSession } from "./driver.js";
import { ComputerUseRuntime } from "./runtime.js";
import { ScreenFeed } from "./screen-feed.js";

afterEach(() => { vi.restoreAllMocks(); });

it("keeps Pi usable after discovery failure and registers exact live tools on retry", async () => {
  const discovery = vi.spyOn(ComputerUseDriverSession.prototype, "listTools")
    .mockRejectedValueOnce(new Error("driver unavailable"))
    .mockRejectedValueOnce(new Error("driver unavailable"))
    .mockResolvedValue([{ name: "platform_action", inputSchema: { type: "object", properties: { target: { type: "string" } } } }]);
  const runtime = new ComputerUseRuntime({
    resolveConfig: () => ({}), loadConfigFromFile: () => ({}), resolveDriverLayout: () => ({}),
    CuaDriverClient: class {
      async listAllTools() { return []; }
      async callTool() { return { content: [] }; }
      async close() {}
    },
  }, new ScreenFeed(() => undefined), () => false, vi.fn());
  const tools = new Map<string, ToolDefinition>();
  const registerCommand = vi.fn();
  const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand, on: vi.fn() } as unknown as ExtensionAPI;
  try {
    await runtime.piFactory()(pi, { sessionId: "retry", cwd: "/workspace" });
    expect([...tools.keys()]).toEqual(["computer_use_connect"]);
    expect(registerCommand).toHaveBeenCalledWith("computer-use-connect", expect.any(Object));
    const connect = tools.get("computer_use_connect")!;
    const failed = await connect.execute("retry-1", {}, undefined, undefined, {} as never);
    expect(failed.content).toEqual([{ type: "text", text: "Computer Use is still unavailable: driver unavailable" }]);
    const success = await connect.execute("retry-2", {}, undefined, undefined, {} as never);
    expect(success.details).toEqual({ registered_tools: 1 });
    expect(tools.get("computer_use_platform_action")?.parameters).toMatchObject({ properties: { target: { type: "string" } } });
    expect(tools.has("computer_use_get_window_state")).toBe(false);
    await runtime.closeThread("retry");
    await expect(connect.execute("stale", {}, undefined, undefined, {} as never)).rejects.toThrow("thread closed");
    expect(discovery).toHaveBeenCalledTimes(3);
  } finally { await runtime.close(); }
});
