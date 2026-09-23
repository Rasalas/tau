import type { UiToolRun } from "../shared/contracts.js";

export interface LiveAssistant {
  id: string;
  text: string;
  thinking: string;
  timestamp: number;
}

/** In-flight state of one thread's current turn, whichever process runs it. */
export interface LiveTurnState {
  readonly tools: Map<string, UiToolRun>;
  currentAssistantId?: string;
  /** Assistant text still streaming, so a thread opened mid-turn shows it. */
  liveAssistant?: LiveAssistant;
  /** Why the current turn failed so far; a later answer in the same run clears it. */
  turnError?: string;
}
