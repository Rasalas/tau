import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ClientTurnIdentity, UiPromptAttachment, UiSkillDraft } from "../shared/contracts";
import { createClientMessageId } from "../workbench/app-state";
import type { SubmitResult } from "./components/Composer";
import { errorMessage } from "../workbench/error-message";
import { FollowUpQueueStore, type QueuedFollowUp } from "../workbench/follow-up-queue";
import type { HostClient } from "../workbench/host-client";
import type { PreferencesStore } from "./preferences";
import { usePreferences } from "./renderer-services-context";

export type SubmitPrompt = (
  value: string,
  attachments?: UiPromptAttachment[],
  delivery?: "followUp" | "steer",
  skillDraft?: UiSkillDraft,
) => Promise<SubmitResult>;

const EMPTY: readonly QueuedFollowUp[] = [];
let backgroundTurnSequence = 0;

/** A thread that is not on screen gets its queued prompt without optimistic transcript state. */
async function deliverInBackground(client: HostClient | undefined, sessionId: string, item: QueuedFollowUp, preferences: PreferencesStore): Promise<SubmitResult> {
  try {
    if (!client) throw new Error("Queued messages require the Electron host.");
    const text = item.skillDraft ? item.text : item.text.trim();
    const prepared = await client.preparePrompt(text, sessionId, item.skillDraft);
    const clientTurn: ClientTurnIdentity = {
      clientTurnId: `queued-turn-${Date.now()}-${backgroundTurnSequence++}`,
      clientMessageId: createClientMessageId(),
    };
    await client.sendPrompt(text, item.attachments, sessionId, clientTurn, prepared);
    preferences.unsettle(sessionId);
    return { accepted: true };
  } catch (error) {
    return { accepted: false, message: errorMessage(error) };
  }
}

/**
 * Follow-ups typed during a run wait per thread until that thread settles,
 * then leave one at a time as ordinary prompts. The visible thread submits
 * through the composer path; other threads are delivered directly.
 */
export function useFollowUpQueue({ client, store, sessionId, isRunning, runningThreadIds, submit, setNotice }: {
  client: HostClient | undefined;
  /** The queue itself; the workbench owns it so a submission can enqueue into it. */
  store: FollowUpQueueStore;
  /** The thread on screen, or undefined while a new-thread draft is open. */
  sessionId: string | undefined;
  /** Reads the one run-state selector; a steer only steers a thread that is working. */
  isRunning(): boolean;
  runningThreadIds: readonly string[];
  /** Sends through the visible composer's path; stable, so this effect never chases a render. */
  submit: SubmitPrompt;
  setNotice(message: string | undefined, level: "error"): void;
}) {
  const preferences = usePreferences();
  const version = useSyncExternalStore(store.subscribe, store.getVersion);
  // The version is the change signal; the list is derived from it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const queue = useMemo(() => (sessionId ? store.list(sessionId) : EMPTY), [sessionId, store, version]);

  // Threads whose next prompt has left the queue but whose run the host has
  // not yet reported. Without this, two queued prompts could leave at once.
  const flushingRef = useRef(new Set<string>());
  useEffect(() => {
    for (const threadId of store.sessionIds()) {
      if (runningThreadIds.includes(threadId)) {
        flushingRef.current.delete(threadId);
        store.resume(threadId);
        continue;
      }
      if (flushingRef.current.has(threadId) || store.isPaused(threadId)) continue;
      const next = store.shift(threadId);
      if (!next) continue;
      flushingRef.current.add(threadId);
      const delivery = threadId === sessionId
        ? submit(next.text, next.attachments, undefined, next.skillDraft)
        : deliverInBackground(client, threadId, next, preferences);
      void delivery.then((result) => {
        if (result.accepted) {
          // Release even if the host never reports a run for this prompt.
          window.setTimeout(() => flushingRef.current.delete(threadId), 5000);
          return;
        }
        flushingRef.current.delete(threadId);
        store.unshift(threadId, next);
        store.pause(threadId);
        setNotice(result.message, "error");
      });
    }
  }, [client, preferences, runningThreadIds, sessionId, setNotice, store, submit, version]);

  const cancelQueued = useCallback((id: string) => {
    if (sessionId) store.remove(sessionId, id);
  }, [sessionId, store]);
  const reorderQueue = useCallback((id: string, toIndex: number) => {
    if (sessionId) store.move(sessionId, id, toIndex);
  }, [sessionId, store]);
  // Sends one queued message ahead of the queue: as a steer while the thread
  // runs, as a plain prompt otherwise.
  const steerQueued = useCallback(async (id: string) => {
    if (!sessionId) return;
    const item = store.remove(sessionId, id);
    if (!item) return;
    const result = await submit(item.text, item.attachments, isRunning() ? "steer" : undefined, item.skillDraft);
    if (!result.accepted) {
      store.unshift(sessionId, item);
      store.pause(sessionId);
      setNotice(result.message, "error");
    }
  }, [isRunning, sessionId, setNotice, store, submit]);

  return { queue, cancelQueued, reorderQueue, steerQueued };
}
