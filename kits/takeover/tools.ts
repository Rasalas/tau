import { Type, type TSchema } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TakeoverOutcome } from "./desk.js";
import { REQUEST_TAKEOVER_TOOL, webUrl, type TakeoverTarget } from "./protocol.js";

// oxlint-disable-next-line typescript/no-explicit-any -- the SDK's own `AnyToolDefinition`, which it does not export.
type AnyTool = ToolDefinition<TSchema, any, any>;

type SessionContext = { sessionManager?: { getSessionId?(): string } } | undefined;

export interface TakeoverRequest {
  reason: string;
  target?: "preview" | "window" | "browser";
  url?: string;
}

/** `threadId` is the Pi session the call came from; absent over MCP, where the credential names the thread. */
type Request = (request: TakeoverRequest, threadId: string | undefined, signal: AbortSignal | undefined) => Promise<TakeoverOutcome | { invalid: string }>;

const parameters = Type.Object({
  reason: Type.String({ description: "What the user should do, in a few words, e.g. \"Sign in to the staging dashboard\" or \"Enter the 2FA code\"" }),
  target: Type.Optional(Type.Union([Type.Literal("preview"), Type.Literal("window"), Type.Literal("browser")], {
    description: "Where: \"preview\" is Tau's Preview page, \"window\" the app you drive with computer use, \"browser\" a page in the user's own browser (needs url). Left out, it is where you last worked.",
  })),
  url: Type.Optional(Type.String({ description: "The page to sign in on, when there is one" })),
});

/** Where a request goes: the agent's word, else where it last worked, else the page it named in the user's browser. */
export function resolveTarget(request: TakeoverRequest, lastSurface: "preview" | "window" | undefined): TakeoverTarget | string {
  const url = webUrl(request.url);
  if (request.url && !url) return "url must be an http or https address.";
  const where = request.target ?? lastSurface ?? (url ? "browser" : undefined);
  if (where === "preview") return url ? { kind: "preview", url } : { kind: "preview" };
  if (where === "window") return { kind: "window" };
  if (where === "browser") return url ? { kind: "browser", url } : "target \"browser\" needs the page's url.";
  return { kind: "none" };
}

const ANSWERS: Record<TakeoverOutcome, { text: string; isError?: true; terminate?: true }> = {
  done: { text: "The user is done and handed control back. Carry on; look at the page or window again before you act, since it changed." },
  cancelled: { text: "The user cancelled the takeover. Stop here and end your turn; do not try again unless they ask.", isError: true, terminate: true },
  timeout: { text: "Nobody took over within 30 minutes. Stop and tell the user what you need from them.", isError: true },
  aborted: { text: "The takeover was stopped.", isError: true },
  busy: { text: "This thread already waits for the user to take over.", isError: true },
};

/**
 * The tool an agent calls when only the user can go on — a sign-in, a
 * one-time code, a captcha. It waits until the user is done or cancels.
 */
export function requestTakeoverTool(request: Request): AnyTool {
  const tool: ToolDefinition<typeof parameters, undefined> = {
    name: REQUEST_TAKEOVER_TOOL,
    label: REQUEST_TAKEOVER_TOOL,
    description: "Get human help with sign-in, 2FA, captchas or consent. Waits for completion or cancellation; stop if cancelled. Never enter passwords yourself or ask for them in chat.",
    promptSnippet: "request_takeover: get human help with sign-in, 2FA, captchas or consent",
    parameters,
    executionMode: "sequential",
    execute: async (_id, params, signal, _update, ctx): Promise<AgentToolResult<undefined> & { isError?: boolean }> => {
      const reason = params.reason.trim().slice(0, 200);
      if (!reason) return { content: [{ type: "text", text: "request_takeover needs a reason." }], details: undefined, isError: true };
      const outcome = await request({ ...params, reason }, (ctx as SessionContext)?.sessionManager?.getSessionId?.(), signal);
      if (typeof outcome === "object") return { content: [{ type: "text", text: `request_takeover: ${outcome.invalid}` }], details: undefined, isError: true };
      const answer = ANSWERS[outcome];
      return {
        content: [{ type: "text", text: answer.text }],
        details: undefined,
        ...(answer.isError ? { isError: true } : {}),
        ...(answer.terminate ? { terminate: true } : {}),
      };
    },
  };
  return tool as unknown as AnyTool;
}
