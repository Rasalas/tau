import { useCallback, useRef, useSyncExternalStore } from "react";
import type { UiPromptAttachment, UiPromptImageAttachment, UiQueuedMessage, UiQueuedPrompt, UiSkillDraft } from "../shared/contracts";
import { combineWakes } from "../shared/message-turns";
import type { WorkbenchActions } from "./extension-system";
import type { SubmitResult } from "./components/Composer";
import { errorMessage } from "../workbench/error-message";
import type { HostClient } from "../workbench/host-client";
import type { ClientStorage } from "../workbench/client-storage";
import { allocateAttachmentId, type ComposerScopeStore } from "../workbench/composer-scope-store";
import { draftKey, readComposerDraft, writeComposerDraft } from "../workbench/draft-store";
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

/** The composer of a thread that is not on screen: its scope, starting from its saved draft when the scope was never loaded. */
export function threadComposer(scopes: ComposerScopeStore, storage: ClientStorage, threadId: string, notify: ComposerPort["notify"]): ComposerPort {
  const key = draftKey(threadId)!;
  return {
    composerDraft: () => scopes.getSnapshot(key).draft || readComposerDraft(storage, key),
    setComposerDraft: (text) => { scopes.setDraft(key, text); writeComposerDraft(storage, key, text); },
    composerImages: () => scopes.getSnapshot(key).attachments.map(({ id: _id, previewUrl: _url, ...image }) => image),
    setComposerImages: (images) => scopes.setAttachments(key, images.map((image) => ({
      ...image, id: allocateAttachmentId(), previewUrl: `data:${image.mimeType};base64,${image.data}`,
    }))),
    notify,
  };
}

/** Puts messages that were not sent back into the composer, below its draft; images come back as images. */
export function returnToComposer(actions: ComposerPort | undefined, taken: readonly UiQueuedPrompt[]): void {
  // A wake is not the user's text: taking it out drops it.
  const items = taken.filter((item) => !item.wake);
  if (!actions || items.length === 0) return;
  const texts = items.map((item) => item.text.trim()).filter(Boolean);
  if (texts.length > 0) actions.setComposerDraft?.([actions.composerDraft().trimEnd(), ...texts].filter(Boolean).join("\n\n"));
  const images = items.flatMap((item) => item.attachments.filter((attachment): attachment is UiPromptImageAttachment => attachment.kind === "image"));
  if (images.length > 0) actions.setComposerImages?.([...(actions.composerImages?.() ?? []), ...images]);
  if (items.some((item) => item.attachments.some((attachment) => attachment.kind === "file"))) {
    actions.notify("The queued message's files did not come back; attach them again.");
  }
}

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
  composerOf(threadId: string): ComposerPort;
}) {
  const shell = useSyncExternalStore(
    useCallback((listener: () => void) => threads.subscribeToThread(sessionId ?? "", listener), [sessionId, threads]),
    useCallback(() => (sessionId ? threads.getThread(sessionId) : undefined), [sessionId, threads]),
  );
  const queue = sessionId ? shell?.queued ?? EMPTY : EMPTY;
  const held = Boolean(sessionId && shell?.queueHeld);

  const report = useCallback((error: unknown) => setNotice(errorMessage(error), "error"), [setNotice]);
  // Takes messages out without sending them: one by id, or the whole queue of a thread, the one on screen unless named.
  const takeQueued = useCallback(async (id?: string, threadId = sessionId): Promise<UiQueuedPrompt[]> => {
    if (!threadId || !client) return [];
    return client.takeQueued(threadId, id).catch((error: unknown) => { report(error); return []; });
  }, [client, report, sessionId]);
  const composerFor = useCallback((threadId: string) => threadId === currentSessionId() ? actions() : composerOf(threadId), [actions, composerOf, currentSessionId]);
  const cancelQueued = useCallback((id: string) => { void takeQueued(id); }, [takeQueued]);
  const reorderQueue = useCallback((id: string, toIndex: number) => {
    if (sessionId && client) void client.moveQueued(sessionId, id, toIndex).catch(report);
  }, [client, report, sessionId]);
  const planQueued = useCallback((id: string, deliverAt: number | undefined) => {
    if (sessionId && client) void client.planQueued(sessionId, id, deliverAt).catch(report);
  }, [client, report, sessionId]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  // Sends one queued message ahead of the queue: as a steer while the thread
  // runs, as a plain prompt otherwise. One that does not go out comes back to the composer.
  // A wake takes every waiting wake with it, as one message.
  const steerQueued = useCallback(async (id: string) => {
    const threadId = sessionId;
    if (!threadId) return;
    const wakes = queueRef.current.some((entry) => entry.id === id && entry.wake) ? queueRef.current.filter((entry) => entry.wake) : [];
    const taken = wakes.length > 1 ? (await Promise.all(wakes.map((entry) => takeQueued(entry.id, threadId)))).flat() : await takeQueued(id, threadId);
    const item = taken.length > 1 ? { ...taken[0]!, ...combineWakes(taken.map((entry) => entry.text)), attachments: taken.flatMap((entry) => entry.attachments) } : taken[0];
    if (!item) return;
    const running = currentSessionId() === threadId && isRunning();
    const result = await submit(item.text, item.attachments, running ? "steer" : undefined, item.skillDraft, threadId);
    if (!result.accepted) {
      returnToComposer(composerFor(threadId), [item]);
      setNotice(result.message, "error");
    }
  }, [composerFor, currentSessionId, isRunning, sessionId, setNotice, submit, takeQueued]);

  const returnQueued = useCallback((id?: string, threadId = sessionId) => {
    if (threadId) void takeQueued(id, threadId).then((items) => returnToComposer(composerFor(threadId), items));
  }, [composerFor, sessionId, takeQueued]);
  const steerQueuedMessage = useCallback(() => {
    const head = queueRef.current[0];
    if (head) void steerQueued(head.id);
    return Boolean(head);
  }, [steerQueued]);
  return { queue, held, cancelQueued, reorderQueue, planQueued, steerQueued, takeQueued, returnQueued, steerQueuedMessage };
}
