import type { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ComputerUseDriverResult } from "./driver.js";

interface VisionConfig {
  visionModel?: { provider: string; model: string };
}
type Screenshot = (args: { pid: number; window_id: number; include_screenshot: true; max_elements: 1 }, signal?: AbortSignal) => Promise<ComputerUseDriverResult>;

/** Pi's optional model-backed analysis uses the same window capture as the shared driver tools. */
export function registerComputerUseVision(pi: ExtensionAPI, config: VisionConfig, getScreenshot: Screenshot, loadCompletion: () => Promise<{ complete: typeof complete }>): void {
  const vision = config.visionModel;
  if (!vision) return;
  pi.registerTool({
    name: "computer_use_analyze_screenshot",
    label: "computer_use_analyze_screenshot",
    description: "Capture a window and analyze its screenshot with the configured vision model. Use pid and window_id from list_windows.",
    parameters: Type.Object({
      pid: Type.Integer(),
      window_id: Type.Integer(),
      instruction: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const capture = await getScreenshot({ pid: params.pid, window_id: params.window_id, include_screenshot: true, max_elements: 1 }, signal);
      const image = capture.content.find((part) => part.type === "image");
      if (capture.isError || !image || image.type !== "image" || !image.data) {
        return { content: [{ type: "text", text: capture.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "Failed to capture screenshot." }], details: undefined, isError: true };
      }
      const model = ctx.modelRegistry.find(vision.provider, vision.model);
      if (!model) throw new Error(`Vision model "${vision.provider}/${vision.model}" not found in model registry.`);
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(`Auth failed for vision model: ${auth.error}`);
      const { complete } = await loadCompletion();
      const answer = await complete(model, {
        systemPrompt: "Analyze the supplied desktop screenshot. Describe visible UI elements, text, dialogs, and overlays. Give coordinates relative to the image's top-left corner, with center coordinates for click targets and bounds where useful. State when a requested element is absent. Perform no actions.",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: params.instruction ?? "Describe the visible windows, controls, and their positions." },
            image,
          ],
          timestamp: Date.now(),
        }],
      }, { maxTokens: 2048, ...(auth.apiKey ? { apiKey: auth.apiKey } : {}), ...(auth.headers ? { headers: auth.headers } : {}), signal });
      return { content: [{ type: "text", text: answer.content.filter((part) => part.type === "text").map((part) => part.text).join("") }], details: undefined };
    },
  });
}
