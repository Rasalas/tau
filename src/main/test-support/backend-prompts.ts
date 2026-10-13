import type { BackendPrompt } from "../host-extensions.js";
import type { ExtensionUiAnswer, ThreadHostEvent } from "../../shared/contracts.js";
import { ExtensionUiCoordinator } from "../extension-ui-coordinator.js";

/** The real dialog record, with a barrier for a backend's first question. */
export function backendPrompts(threadId: string) {
  const events: ThreadHostEvent[] = [];
  const answers: ExtensionUiAnswer[] = [];
  const ui = new ExtensionUiCoordinator((_thread, event) => events.push(event), () => undefined);
  let announce!: () => void;
  const opened = new Promise<void>((resolve) => { announce = resolve; });
  let sequence = 0;
  return {
    ui, events, answers, opened,
    ask: async (prompt: BackendPrompt) => {
      const answer = ui.ask({ ...prompt, id: `prompt-${++sequence}`, sessionId: threadId });
      announce();
      const result = await answer;
      answers.push(result);
      return result;
    },
    cancelPrompts: () => ui.cancelFor(threadId),
  };
}
