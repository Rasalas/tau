import { beforeEach, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import { registerComputerUseVision } from "./vision.js";

vi.mock("@earendil-works/pi-ai/compat", () => ({ complete: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); });

it("registers analysis only when a vision model is configured", () => {
  const registerTool = vi.fn();
  registerComputerUseVision({ registerTool } as unknown as ExtensionAPI, {}, vi.fn(), async () => ({ complete }));
  expect(registerTool).not.toHaveBeenCalled();
});

it("captures through the shared driver and forwards the image and model credentials", async () => {
  let tool: ToolDefinition | undefined;
  const pi = { registerTool: (value: ToolDefinition) => { tool = value; } } as unknown as ExtensionAPI;
  const image = { type: "image" as const, data: "image-data", mimeType: "image/png" };
  const capture = vi.fn(async () => ({ content: [image], details: undefined }));
  registerComputerUseVision(pi, { visionModel: { provider: "sample", model: "vision" } }, capture, async () => ({ complete }));
  const model = { id: "vision" };
  const ctx = { modelRegistry: { find: vi.fn(() => model), getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key", headers: { sample: "header" } })) } } as unknown as ExtensionToolContext;
  vi.mocked(complete).mockResolvedValue({ content: [{ type: "text", text: "Button at (10, 20)." }] } as never);
  const signal = new AbortController().signal;
  const result = await tool!.execute("call", { pid: 4, window_id: 5, instruction: "Find button" }, signal, undefined, ctx);
  expect(capture).toHaveBeenCalledWith({ pid: 4, window_id: 5, include_screenshot: true, max_elements: 1 }, signal);
  expect(complete).toHaveBeenCalledWith(model, expect.objectContaining({ messages: [expect.objectContaining({ content: [{ type: "text", text: "Find button" }, image] })] }), expect.objectContaining({ apiKey: "key", headers: { sample: "header" }, signal }));
  expect(result.content).toEqual([{ type: "text", text: "Button at (10, 20)." }]);
});

it("returns capture errors without calling the vision model", async () => {
  let tool: ToolDefinition | undefined;
  registerComputerUseVision({ registerTool: (value: ToolDefinition) => { tool = value; } } as unknown as ExtensionAPI,
    { visionModel: { provider: "sample", model: "vision" } }, async () => ({ content: [{ type: "text", text: "Window disappeared" }], details: undefined, isError: true }), async () => ({ complete }));
  const result = await tool!.execute("call", { pid: 4, window_id: 5 }, undefined, undefined, {} as ExtensionToolContext);
  expect(result.content).toEqual([{ type: "text", text: "Window disappeared" }]);
  expect(complete).not.toHaveBeenCalled();
});
