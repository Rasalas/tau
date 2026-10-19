import { Type } from "typebox";
import type { HostExtensionContext, HostMcpTool } from "tau/host-extension";
import type { WindowScreenshot } from "./screenshot-crop.js";

const answer = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: { available: false }, ...(isError ? { isError } : {}) });

/** `tau_window_screenshot`: how Tau's own window looks right now, optionally around one package's regions. */
export function windowScreenshotTools(context: HostExtensionContext): HostMcpTool[] {
  const { services } = context;
  return [{
    annotations: { readOnlyHint: true },
    name: "tau_window_screenshot",
    label: "Tau window screenshot",
    description: "Look at Tau's own window on the user's machine, to check how a Tau package you built renders. With `extension` set to the package's id, the picture is cropped around the regions it put on screen; if none is visible you get the whole window and a note. Never shows other apps. Does not include the Preview page.",
    promptSnippet: "tau_window_screenshot: see how a Tau package looks in the user's window",
    parameters: Type.Object({
      extension: Type.Optional(Type.String({ description: "A package's id, e.g. local.copy-branch: crop around the regions it registered." })),
      margin: Type.Optional(Type.Number({ description: "Pixels of window kept around those regions; 48 by default." })),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const fields = params && typeof params === "object" ? params as Record<string, unknown> : {};
      const extension = typeof fields.extension === "string" && fields.extension.trim() ? fields.extension.trim() : undefined;
      let shot: WindowScreenshot;
      try {
        shot = await services.callClient("screenshot", { ...(extension ? { extension } : {}), ...(typeof fields.margin === "number" ? { margin: fields.margin } : {}) }, { window: "host" }) as WindowScreenshot;
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return answer(`No window: this host has no Tau window to look at (a headless or remote host has none). ${why}`, true);
      }
      if (!shot.available) return answer(`No window: ${shot.reason}`, true);
      const { image } = shot;
      const note = !extension ? "the whole window"
        : shot.cropped ? `cropped around ${extension}'s regions (${shot.extension?.parts.join(", ") || "no named part"})`
          : `the whole window: region not visible, ${extension} has nothing on screen (not installed or allowed yet, or its panel is closed)`;
      return {
        content: [
          { type: "text" as const, text: `Tau window screenshot, ${image.width}×${image.height}: ${note}.` },
          { type: "image" as const, data: image.data, mimeType: image.mimeType },
        ],
        details: { available: true, cropped: shot.cropped, ...(shot.extension ? { extension: shot.extension } : {}) },
      };
    },
  }];
}
