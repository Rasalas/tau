import { loadQueuedMessageActions } from "./deferred-surfaces";
import { useCallback, useRef, useSyncExternalStore } from "react";
import type { UiPromptAttachment, UiQueuedMessage, UiQueuedPrompt, UiSkillDraft } from "../shared/contracts";
import type { WorkbenchActions } from "./extension-system";
import type { SubmitResult } from "./components/Composer";
import { errorMessage } from "../workbench/error-message";
import type { HostClient } from "../workbench/host-client";
import type { SubmitDelivery } from "../workbench/submission-queue";
import type { ThreadStore } from "../workbench/thread-store";

export type SubmitPrompt = (
  value: string,
  attachments?: UiPromptAttachment[],
  delivery?: SubmitDelivery,
  skillDraft?: UiSkillDraft,
  /** The thread the message belongs to; it goes there even when another thread is on screen by then. */
  threadId?: string,
) => Promise<SubmitResult>;

const EMPTY: readonly UiQueuedMessage[] = [];

/** What a message that was not sent goes back into. */
export type ComposerPort = Pick<WorkbenchActions, "composerDraft" | "setComposerDraft" | "composerImages" | "setComposerImages" | "notify">;

/**
 * The thread's queue as the composer sees it. The host keeps the queue and
 * sends its head when the thread settles (it outlives the window and a
 * restart); this reads it from the thread's shell and edits it through the host.
 */
export function useFollowUpQueue({ client, threads, sessionId, currentSessionId, isRunning, submit, setNotice, actions, composerOf }: {
  client: HostClient | undefined;
  /** Where the host's thread shells, and with them each queue, arrive. */
  threads: ThreadStore;
  /** The thread on screen, or undefined while a new-thread draft is open. */
  sessionId: string | undefined;
  /** The same, read now: a host reply may land after the user moved on. */
  currentSessionId(): string | undefined;
  /** Reads the one run-state selector; a steer only steers a thread that is working. */
  isRunning(): boolean;
  /** Sends through the visible composer's path; stable, so this effect never chases a render. */
  submit: SubmitPrompt;
  setNotice(message: string | undefined, level: "error"): void;
  /** Where a message that could not be sent goes back to while its thread is on screen. */
  actions(): WorkbenchActions | undefined;
  /** The composer of a thread that is not on screen. */
  composerOf(threadId: string): ComposerPort | Promise<ComposerPort>;
}) {
  const shell = useSyncExternalStore(
    useCallback((listener: () => void) => threads.subscribeToThread(sessionId ?? "", listener), [sessionId, threads]),
    useCallback(() => (sessionId ? threads.getThread(sessionId) : undefined), [sessionId, threads]),
  );
  const queue = sessionId ? shell?.queued ?? EMPTY : EMPTY;

  const report = useCallback((error: unknown) => setNotice(errorMessage(error), "error"), [setNotice]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  // Takes messages out without sending them: one by id, or the whole queue of a thread, the one on screen unless named.
  const takeQueued = useCallback(async (id?: string, threadId = sessionId): Promise<UiQueuedPrompt[]> => {
    if (!threadId || !client) return [];
    return client.takeQueued(threadId, id).catch((error: unknown) => { report(error); return []; });
  }, [client, report, sessionId]);
  const composerFor = useCallback((threadId: string) => threadId === currentSessionId() ? actions() : composerOf(threadId), [actions, composerOf, currentSessionId]);
  // Keep the target and its queue position before loading the action code.
  const cancelQueued = useCallback((id: string) => {
    const threadId = sessionId;
    if (!threadId || !client) return;
    const index = Math.max(0, queueRef.current.findIndex((entry) => entry.id === id));
    void loadQueuedMessageActions().then(({ removeQueued }) => removeQueued(client, threadId, id, index, actions()?.toast, report)).catch(report);
  }, [actions, client, report, sessionId]);
  const reorderQueue = useCallback((id: string, toIndex: number) => {
    if (sessionId && client) void client.moveQueued(sessionId, id, toIndex).catch(report);
  }, [client, report, sessionId]);
  const planQueued = useCallback((id: string, deliverAt: number | undefined) => {
    if (sessionId && client) void client.planQueued(sessionId, id, deliverAt).catch(report);
  }, [client, report, sessionId]);
  // Sends one queued message ahead of the queue: as a steer while the thread
  // runs, as a plain prompt otherwise. One that does not go out comes back to the composer.
  // A wake takes every waiting wake with it, as one message.
  const steerQueued = useCallback(async (id: string) => {
    const threadId = sessionId;
    if (!threadId) return;
    const queued = queueRef.current;
    const queueActions = await loadQueuedMessageActions().catch(report);
    if (!queueActions) return;
    const item = await queueActions.takeForSteer(takeQueued, threadId, id, queued);
    if (!item) return;
    const running = currentSessionId() === threadId && isRunning();
    const result = await submit(item.text, item.attachments, running ? "steer" : undefined, item.skillDraft, threadId);
    if (!result.accepted) {
      queueActions.returnToComposer(await composerFor(threadId), [item]);
      setNotice(result.message, "error");
    }
  }, [composerFor, currentSessionId, isRunning, report, sessionId, setNotice, submit, takeQueued]);

  const returnQueued = useCallback((id?: string, threadId = sessionId) => {
    if (threadId) void loadQueuedMessageActions().then(({ returnToComposer }) => takeQueued(id, threadId).then(async (items) => returnToComposer(await composerFor(threadId), items))).catch(report);
  }, [composerFor, report, sessionId, takeQueued]);
  const steerQueuedMessage = useCallback(() => {
    const head = queueRef.current[0];
    if (head) void steerQueued(head.id);
    return !!head;
  }, [steerQueued]);
  return { queue, held: !!(sessionId && shell?.queueHeld), cancelQueued, reorderQueue, planQueued, steerQueued, takeQueued, returnQueued, steerQueuedMessage };
}
