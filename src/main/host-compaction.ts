import type { HostEvent, UiPromptAttachment, UiSkillDraft } from "../shared/contracts.js";
import type { HostReport } from "./host-report.js";
import type { PromptPreparation } from "./prompt-preparation.js";
import type { QueuedMessages } from "./queued-messages.js";
import { requireCapability } from "./runtime-types.js";
import type { ThreadRuntime } from "./thread-runtime.js";

type CompactionPrompt = { text: string; attachments: UiPromptAttachment[]; skillDraft?: UiSkillDraft };

interface CompactionServices {
  queue: Pick<QueuedMessages, "submit" | "hold" | "pump">;
  prompts: Pick<PromptPreparation, "checked">;
  report: Pick<HostReport, "log" | "fail">;
  emit(event: HostEvent): void;
}

/** Accepts queued prompts before compaction, then delivers them only after it succeeds. */
export async function compactThreadContext(thread: ThreadRuntime, prompt: CompactionPrompt | undefined, services: CompactionServices): Promise<void> {
  const capability = requireCapability(thread.backend, "compaction");
  if (thread.compactionPending) throw new Error("This thread is already compacting its context.");
  thread.compactionPending = true;
  try {
    if (prompt) await services.queue.submit(thread.threadId, { ...prompt, attachments: services.prompts.checked(thread, prompt.attachments) });
  } catch (error) {
    thread.compactionPending = false;
    throw error;
  }
  services.emit({ type: "context-compaction", sessionId: thread.threadId, running: true });
  const compact = async () => {
    let completed = false;
    try {
      await capability.compact();
      completed = true;
      services.report.log("context.compacted");
    } catch (error) {
      if (!prompt) throw error;
      services.queue.hold(thread.threadId);
      services.emit({ type: "notice", sessionId: thread.threadId, level: "error", message: `Compaction failed. Your message is waiting in the queue: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      thread.compactionPending = false;
      services.emit({ type: "context-compaction", sessionId: thread.threadId, running: false });
    }
    if (completed && prompt) await services.queue.pump(thread.threadId);
  };
  // A queued message is accepted as soon as the host owns it. Long compactions
  // must not time out the request and resurrect an already accepted draft.
  if (prompt) void compact().catch((error) => services.report.fail(error, thread.threadId));
  else await compact();
}
