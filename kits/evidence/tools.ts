import { Type, type TSchema } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";

// oxlint-disable-next-line typescript/no-explicit-any -- the SDK's own `AnyToolDefinition`, which it does not export.
type AnyTool = ToolDefinition<TSchema, any, any>;

export const ATTACH_EVIDENCE_TOOL = "attach_evidence";

/** `threadId` is the Pi session the call came from; absent over MCP, where the credential names the thread. */
type Attach = (caption: string, source: "preview" | "window" | undefined, threadId: string | undefined) => Promise<string>;

type SessionContext = { sessionManager?: { getSessionId?(): string } } | undefined;

const parameters = Type.Object({
  caption: Type.String({ description: "What the picture proves, e.g. \"before: the header is grey\" or \"after: the header is blue\"" }),
  source: Type.Optional(Type.Union([Type.Literal("preview"), Type.Literal("window")], { description: "The Preview's page, or the window you drive with computer use; the Preview first when left out" })),
});

/**
 * The tool a thread's agent calls to put a picture on the turn it is in. The
 * thread comes from whoever registers it — the runtime or the MCP credential —
 * never from the call.
 */
export function attachEvidenceTool(attach: Attach): AnyTool {
  const tool: ToolDefinition<typeof parameters, undefined> = {
    name: ATTACH_EVIDENCE_TOOL,
    label: ATTACH_EVIDENCE_TOOL,
    description: "Show the user visual evidence of a change or bug with a captioned screenshot. Captures the current preview or driven window, not a saved image.",
    promptSnippet: "attach_evidence: show the user visual evidence of a change or bug",
    parameters,
    executionMode: "sequential",
    execute: async (_id, params, _signal, _update, ctx): Promise<AgentToolResult<undefined> & { isError?: boolean }> => {
      const caption = params.caption.trim().slice(0, 160);
      if (!caption) return { content: [{ type: "text", text: "attach_evidence needs a caption." }], details: undefined, isError: true };
      const answer = await attach(caption, params.source, (ctx as SessionContext)?.sessionManager?.getSessionId?.());
      return { content: [{ type: "text", text: answer }], details: undefined, ...(answer.startsWith("Attached") ? {} : { isError: true }) };
    },
  };
  return tool as unknown as AnyTool;
}
