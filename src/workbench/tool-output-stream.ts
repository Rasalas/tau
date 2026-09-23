import type { HostEvent, UiTurnActivity } from "../shared/contracts";
import type { HostPush, HostPushEvent, HostWireEvent } from "../shared/host-transport";
import { applyToolOutputDelta } from "../shared/tool-output-delta";

const toolKey = (sessionId: string, id: string) => `${sessionId}\u0000${id}`;

export function isWireEvent(event: HostPushEvent): event is HostWireEvent {
  return event.type === "tool-update-delta" || event.type === "tool-end-delta" || event.type === "thread-detail-compact";
}

/**
 * Turns the transport's compact pushes back into the events every listener
 * reads, from the outputs of the pushes this client saw. A `tool-update-delta`
 * against a push it never saw is dropped (the host sends the whole output
 * again soon); such a `tool-end-delta` ends the tool with its output deferred,
 * so the row loads it on request.
 */
export class ToolOutputStream {
  private readonly outputs = new Map<string, { seq: number; output: string }>();

  receive(push: HostPush): HostPushEvent | undefined {
    const { event } = push;
    switch (event.type) {
      case "tool-update":
        this.outputs.set(toolKey(event.sessionId, event.id), { seq: push.seq, output: event.output });
        return event;
      case "tool-update-delta": {
        const key = toolKey(event.sessionId, event.id);
        const base = this.outputs.get(key);
        const output = base?.seq === event.after ? applyToolOutputDelta(base.output, event) : undefined;
        if (output === undefined) {
          this.outputs.delete(key);
          return undefined;
        }
        this.outputs.set(key, { seq: push.seq, output });
        return { type: "tool-update", sessionId: event.sessionId, id: event.id, output };
      }
      case "tool-end-delta": {
        const key = toolKey(event.sessionId, event.tool.id);
        const base = this.outputs.get(key);
        this.outputs.delete(key);
        const output = base?.seq === event.after ? applyToolOutputDelta(base.output, event) : undefined;
        const tool = output === undefined
          ? { ...event.tool, outputDeferred: true, outputLength: event.length }
          : { ...event.tool, output };
        return { type: "tool-end", sessionId: event.sessionId, tool };
      }
      case "thread-detail-compact": {
        const { detail } = event.update;
        const last = detail.turnActivityHistory?.at(-1);
        const turnActivity: UiTurnActivity | undefined = last && {
          tools: last.tools,
          ...(last.anchorMessageId === undefined ? {} : { anchorMessageId: last.anchorMessageId }),
        };
        return { type: "host-update", update: { ...event.update, detail: { ...detail, ...(turnActivity ? { turnActivity } : {}) } } } satisfies HostEvent;
      }
      case "tool-end":
        this.outputs.delete(toolKey(event.sessionId, event.tool.id));
        return event;
      case "agent-status":
        if (!event.running) {
          const prefix = toolKey(event.sessionId, "");
          for (const key of this.outputs.keys()) if (key.startsWith(prefix)) this.outputs.delete(key);
        }
        return event;
      default:
        return event;
    }
  }

  clear(): void {
    this.outputs.clear();
  }
}
