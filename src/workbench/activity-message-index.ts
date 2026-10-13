import type { UiMessage, UiToolRun } from "../shared/contracts";

export interface ActivitySegment {
  anchorMessageId?: string;
  tools: UiToolRun[];
}

/** Placement reads message structure, never the growing streamed text. */
export class ActivityMessageIndex {
  private readonly positions = new Map<string, number>();
  private readonly anchors = new Map<string, number>();
  private readonly answers: (number | undefined)[] = [];
  private readonly messages;
  private readonly firstAnswer?: number;

  constructor(messages: readonly UiMessage[]) {
    this.messages = messages.map((message, index) => {
      if (!this.positions.has(message.id)) this.positions.set(message.id, index);
      for (const id of [message.id, message.sourceEntryId]) {
        if (id !== undefined && !this.anchors.has(id)) this.anchors.set(id, index);
      }
      return { id: message.id, role: message.role, timestamp: message.timestamp, hasText: Boolean(message.text.trim()) };
    });
    let answer: number | undefined;
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      this.answers[index] = answer;
      const message = this.messages[index];
      if (message.role === "user") answer = undefined;
      else if (message.role === "assistant" && message.hasText && answer === undefined) answer = message.timestamp;
    }
    this.firstAnswer = answer;
  }

  answerAfter(anchorMessageId?: string): number | undefined {
    const index = anchorMessageId === undefined ? undefined : this.positions.get(anchorMessageId);
    return index === undefined ? this.firstAnswer : this.answers[index];
  }

  /** Keep calls in message order, including work after a steering prompt and its reply. */
  splitTools(tools: readonly UiToolRun[], anchorMessageId?: string, persistent: (tool: UiToolRun) => boolean = () => false): ActivitySegment[] {
    const anchorIndex = anchorMessageId === undefined ? undefined : this.anchors.get(anchorMessageId);
    const segments: ActivitySegment[] = [];
    for (const tool of tools) {
      let anchor = anchorMessageId;
      if (anchorIndex !== undefined) {
        for (let index = anchorIndex + 1; index < this.messages.length; index += 1) {
          const message = this.messages[index];
          if (message.role === "user") {
            // Persistent cards stay at their call while their work continues.
            if ((tool.status !== "running" || persistent(tool)) && message.timestamp > tool.startedAt) break;
            anchor = message.id;
          } else if (message.hasText && message.timestamp <= tool.startedAt) anchor = message.id;
        }
      }
      const previous = segments.at(-1);
      if (previous && previous.anchorMessageId === anchor) previous.tools.push(tool);
      else segments.push({ anchorMessageId: anchor, tools: [tool] });
    }
    return segments;
  }
}
