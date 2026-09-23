import type { HostEvent, UiMessage } from "../shared/contracts";
import type { HostPush, HostPushEvent } from "../shared/host-transport";
import { applyToolOutputDelta } from "../shared/tool-output-delta";

const messageKey = (sessionId: string, id: string) => `${sessionId}\u0000${id}`;

/** Twice the host's `REMEMBERED_ENDED_MESSAGES`, so this side never forgets first. */
const REMEMBERED_ENDED_MESSAGES = 128;

interface StreamedText {
  seq: number;
  text: string;
  thinking: string;
}

interface EndedText {
  seq: number;
  text: string;
  thinking?: string;
}

/**
 * Puts message texts back into `assistant-end-delta` and compact details. A reference it cannot
 * resolve drops the push and sets `lost`, and the connection starts over from a snapshot.
 */
export class MessageTextStream {
  private readonly streamed = new Map<string, StreamedText>();
  private readonly ended = new Map<string, EndedText>();
  lost = false;

  receive(push: HostPush): HostPushEvent | undefined {
    const { event } = push;
    switch (event.type) {
      case "assistant-start":
        this.streamed.set(messageKey(event.sessionId, event.id), { seq: push.seq, text: "", thinking: "" });
        return event;
      case "assistant-delta":
      case "assistant-thinking": {
        const streamed = this.streamed.get(messageKey(event.sessionId, event.id));
        if (streamed) {
          streamed.seq = push.seq;
          streamed[event.type === "assistant-delta" ? "text" : "thinking"] += event.delta;
        }
        return event;
      }
      case "assistant-end": {
        const key = messageKey(event.sessionId, event.message.id);
        this.streamed.delete(key);
        this.remember(key, push.seq, event.message);
        return event;
      }
      case "assistant-end-delta": {
        const key = messageKey(event.sessionId, event.message.id);
        const streamed = this.streamed.get(key);
        this.streamed.delete(key);
        const base = streamed?.seq === event.after ? streamed : undefined;
        const text = base && applyToolOutputDelta(base.text, event.text);
        const thinking = base && event.thinking ? applyToolOutputDelta(base.thinking, event.thinking) : undefined;
        if (text === undefined || (event.thinking && thinking === undefined)) return this.lose();
        const message: UiMessage = { ...event.message, text, ...(thinking === undefined ? {} : { thinking }) };
        this.remember(key, push.seq, message);
        return { type: "assistant-end", sessionId: event.sessionId, message } satisfies HostEvent;
      }
      case "assistant-anchor": {
        const ended = this.ended.get(messageKey(event.sessionId, event.id));
        if (ended) this.remember(messageKey(event.sessionId, event.sourceEntryId), ended.seq, ended);
        return event;
      }
      case "thread-detail-compact": {
        if (!event.texts) return event;
        const { detail } = event.update;
        let missing = false;
        const messages = detail.messages.map((message) => {
          const seq = event.texts![message.id];
          if (seq === undefined) return message;
          const ended = this.ended.get(messageKey(detail.sessionId, message.id));
          if (ended?.seq !== seq) {
            missing = true;
            return message;
          }
          return { ...message, text: ended.text, ...(ended.thinking === undefined ? {} : { thinking: ended.thinking }) };
        });
        if (missing) return this.lose();
        const { texts: _texts, ...rest } = event;
        return { ...rest, update: { ...event.update, detail: { ...detail, messages } } };
      }
      case "agent-status":
        if (event.running) {
          const prefix = messageKey(event.sessionId, "");
          for (const map of [this.streamed, this.ended] as Map<string, unknown>[]) {
            for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
          }
        }
        return event;
      default:
        return event;
    }
  }

  clear(): void {
    this.streamed.clear();
    this.ended.clear();
  }

  private remember(key: string, seq: number, message: Pick<UiMessage, "text" | "thinking">): void {
    this.ended.delete(key);
    this.ended.set(key, { seq, text: message.text, ...(message.thinking === undefined ? {} : { thinking: message.thinking }) });
    if (this.ended.size > REMEMBERED_ENDED_MESSAGES) this.ended.delete(this.ended.keys().next().value!);
  }

  private lose(): undefined {
    this.lost = true;
    return undefined;
  }
}
