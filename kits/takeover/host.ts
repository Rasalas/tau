import type { HostExtension, HostExtensionContext, RuntimeExtensionFactory } from "tau/host-extension";
import { TakeoverDesk } from "./desk.js";
import { EVIDENCE_EXTENSION_ID, TAKEOVER_EXTENSION_ID, TAKEOVER_STATE_EVENT, surfaceOf } from "./protocol.js";
import { requestTakeoverTool, resolveTarget, type TakeoverRequest } from "./tools.js";

type PiApi = Parameters<RuntimeExtensionFactory>[0];

const idOf = (input: unknown): string => {
  const id = input && typeof input === "object" ? (input as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !id) throw new Error("Takeover needs id.");
  return id;
};

/**
 * Takeover Kit's host entry: `request_takeover` for Pi and over MCP, the
 * requests that wait for the user, published to every client, and the hold on
 * Computer Use, the Preview and Evidence while the user is in control.
 */
export function createTakeoverHostExtension(options: { timeoutMs?: number } = {}): HostExtension {
  return {
    id: TAKEOVER_EXTENSION_ID,
    name: "Takeover",
    permissions: ["sessions", "runtime:extend"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      const log = (label: string, detail?: string) => services.log(label, detail);
      const desk = new TakeoverDesk({
        publish: (takeovers) => context.emit(TAKEOVER_STATE_EVENT, { takeovers }),
        pauseEvidence: (threadId, reason) => context.invokeHostExtension(EVIDENCE_EXTENSION_ID, "pause", { threadId, reason: `The user took over: ${reason}` }),
        resumeEvidence: (threadId) => context.invokeHostExtension(EVIDENCE_EXTENSION_ID, "resume", { threadId }),
        describe: (threadId) => {
          const thread = services.thread(threadId);
          const title = thread?.sessionName();
          return { ...(title ? { title } : {}), ...(thread?.sessionFile ? { sessionFile: thread.sessionFile } : {}) };
        },
        log,
        now: () => Date.now(),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
      /** Where each thread's agent last worked, so a request without a target goes there. */
      const surfaces = new Map<string, "preview" | "window">();
      const request = async (threadId: string, params: TakeoverRequest, signal: AbortSignal | undefined) => {
        const target = resolveTarget(params, surfaces.get(threadId));
        if (typeof target === "string") return { invalid: target };
        return desk.request(threadId, params.reason, target, signal);
      };

      const disposers: Array<() => void> = [];
      disposers.push(services.registerTurnObserver({
        toolEnded: (threadId, tool) => {
          const surface = surfaceOf(tool.name);
          if (surface) surfaces.set(threadId, surface);
        },
        closed: async (threadId) => {
          surfaces.delete(threadId);
          desk.endThread(threadId);
        },
      }));

      const factory: RuntimeExtensionFactory = (pi: PiApi, session) => {
        pi.registerTool(requestTakeoverTool((params, threadId, signal) => request(threadId ?? session.sessionId, params, signal)));
        pi.on("tool_call", (event) => desk.hold(event.toolName));
      };
      disposers.push(services.registerRuntimeExtension("tau-takeover", factory));
      disposers.push(services.mcp.registerTools((thread) => [
        requestTakeoverTool((params, _threadId, signal) => request(thread.sessionId, params, signal)),
      ]));
      disposers.push(services.mcp.gate((call) => desk.hold(call.toolName)));

      context.registerCommand("state", () => desk.list(), { access: "read" });
      context.registerCommand("done", (input) => desk.finish(idOf(input), "done"));
      context.registerCommand("cancel", (input) => desk.finish(idOf(input), "cancelled"));

      return () => {
        for (const dispose of disposers.reverse()) dispose();
        desk.dispose();
      };
    },
  };
}

export default createTakeoverHostExtension;
