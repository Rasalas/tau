import type { HostPush, HostPushEvent } from "../shared/host-transport";
import { applyToolOutputDelta } from "../shared/tool-output-delta";

const toolKey = (sessionId: string, id: string) => `${sessionId}\u0000${id}`;

/**
 * Turns `tool-update-delta` pushes back into the `tool-update` every listener
 * reads, from the outputs of the pushes this client saw. A delta against a
 * push it never saw is dropped; the host sends the whole output again soon.
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
