import { Type } from "typebox";
import type { HostExtensionContext, HostMcpTool } from "tau/host-extension";
import { customizeInstructionsFor } from "./customize-instructions.js";
import { windowScreenshotTools } from "./window-screenshot-tool.js";

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** `tau_new_package`: a package to start from, in the user's global extension folder. */
export function newPackageTools(context: HostExtensionContext): HostMcpTool[] {
  const { services } = context;
  return [{
    annotations: { readOnlyHint: false },
    name: "tau_new_package",
    label: "New Tau package",
    description: "Create a Tau package, the way to change or extend Tau (buttons, panels, commands, themes). It is written to the user's extension folder with the extension API's types and an AGENTS.md recipe, and is not installed or approved yet.",
    promptSnippet: "tau_new_package: create a package that customizes Tau",
    parameters: Type.Object({
      name: Type.String({ description: "Short folder name: lowercase letters, digits and dashes, e.g. copy-branch." }),
      displayName: Type.Optional(Type.String({ description: "The name Settings shows; the title-cased folder name by default." })),
      description: Type.Optional(Type.String({ description: "One sentence on what the package does for the user." })),
      host: Type.Optional(Type.Boolean({ description: "Also write a half that runs outside the window and can start programs; false by default, most changes need the window half only." })),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      const fields = params && typeof params === "object" ? params as Record<string, unknown> : {};
      const made = await services.newPackage({
        slug: text(fields.name) ?? "",
        ...(text(fields.displayName) ? { displayName: text(fields.displayName) } : {}),
        ...(text(fields.description) ? { description: text(fields.description) } : {}),
        host: fields.host === true,
      });
      services.log("packages.new", `${made.id} → ${made.directory}`);
      return toolResult({
        ...made,
        next: `Read ${made.directory}/AGENTS.md, edit the files in ${made.directory}, then call tau_install_package with that folder.`,
      });
    },
  }];
}

/** The customize tools (a new package, a look at the result) and the instructions, for Pi and for every runtime reached over MCP. */
export function registerNewPackage(context: HostExtensionContext): () => void {
  const { services } = context;
  const tools = [...newPackageTools(context), ...windowScreenshotTools(context)];
  const disposers = [
    services.registerRuntimeExtension("tau-new-package", (pi, session) => {
      for (const tool of tools) pi.registerTool(tool);
      pi.on("before_agent_start", (event) => {
        const instructions = customizeInstructionsFor(session.cwd);
        return instructions ? { systemPrompt: `${event.systemPrompt}\n\n${instructions}` } : undefined;
      });
    }),
    services.mcp.registerTools(() => tools),
    services.mcp.registerInstructions?.((thread) => customizeInstructionsFor(thread.cwd)) ?? (() => undefined),
  ];
  return () => { for (const dispose of disposers.reverse()) dispose(); };
}
