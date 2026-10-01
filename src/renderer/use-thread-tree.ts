import { useCallback, useRef, useState, type RefObject } from "react";
import type { UiMessage, UiThreadTree } from "../shared/contracts";
import { visibleUserMessageText } from "./components/MessageText";
import type { HostActionResult } from "../shared/host-protocol";
import { errorMessage } from "../workbench/error-message";
import type { HostClient } from "../workbench/host-client";
import type { ThreadTreeMode } from "./components/ThreadTreeModal";

export interface ThreadTreeModalState {
  mode: ThreadTreeMode;
  tree?: UiThreadTree;
  error?: string;
  busy: boolean;
}

export interface ThreadTreePorts {
  client?: HostClient;
  /** The thread the tree is of; read at call time, never from a stale render. */
  sessionId(): string | undefined;
  requireHost(what: string): boolean;
  applyActionResult(result: HostActionResult): boolean;
  /** A navigation may hand back unsent text, which lands in the composer. */
  seedComposer(text: string): void;
  /** What the composer holds now, kept above a prompt that comes back to it. */
  composerDraft?(): string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  notify?(message: string): void;
  /** True when a kit's prompt took the fork; it asks for the branch itself. */
  requestFork?(request: { entryId: string }): boolean;
}

/**
 * Pi's `/tree`, `/fork` and `/clone` for the thread on screen: one modal, its
 * fetch and the two moves that close it. Only the modal is React; what it does
 * to the thread is `ThreadCommands`.
 */
export function useThreadTree(ports: ThreadTreePorts) {
  const [threadTreeModal, setThreadTreeModal] = useState<ThreadTreeModalState>();
  const closeThreadTree = useCallback(() => setThreadTreeModal(undefined), []);
  const { applyActionResult, client, composerRef, requireHost, sessionId } = ports;
  // Read when called: the composer callbacks may be new on every render of the caller.
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const seedComposer = useCallback((text: string) => portsRef.current.seedComposer(text), []);

  const openThreadTree = useCallback((mode: ThreadTreeMode = "navigate") => {
    if (!requireHost("Thread tree")) return;
    setThreadTreeModal({ mode, busy: false });
    client!.threadTree(sessionId())
      .then((tree) => setThreadTreeModal((current) => current && { ...current, tree }))
      .catch((error) => setThreadTreeModal((current) => current && { ...current, error: errorMessage(error) }));
  }, [client, requireHost, sessionId]);

  const navigateThreadTree = useCallback(async (entryId: string, summarize: boolean) => {
    setThreadTreeModal((current) => current && { ...current, busy: true, error: undefined });
    try {
      const result = await client!.navigateThreadTree(entryId, { summarize }, sessionId());
      if (result.cancelled) {
        setThreadTreeModal((current) => current && { ...current, busy: false });
        return;
      }
      applyActionResult(result);
      setThreadTreeModal(undefined);
      if (result.draftText) seedComposer(result.draftText);
      composerRef.current?.focus();
    } catch (error) {
      setThreadTreeModal((current) => current && { ...current, busy: false, error: errorMessage(error) });
    }
  }, [applyActionResult, client, composerRef, seedComposer, sessionId]);

  const forkFromTree = useCallback(async (entryId: string) => {
    if (portsRef.current.requestFork?.({ entryId })) { setThreadTreeModal(undefined); return; }
    setThreadTreeModal((current) => current && { ...current, busy: true, error: undefined });
    try {
      applyActionResult(await client!.forkThread(entryId, sessionId()));
      setThreadTreeModal(undefined);
    } catch (error) {
      setThreadTreeModal((current) => current && { ...current, busy: false, error: errorMessage(error) });
    }
  }, [applyActionResult, client, sessionId]);

  // "Edit from here": the conversation goes back to before this prompt, which
  // returns to the composer below the draft. The later turns stay a branch of the tree.
  const editFromMessage = useCallback(async (message: UiMessage) => {
    if (!message.sourceEntryId || !requireHost("Edit from here")) return;
    try {
      const result = await client!.navigateThreadTree(message.sourceEntryId, { summarize: false }, sessionId());
      if (result.cancelled) return;
      applyActionResult(result);
      const draft = portsRef.current.composerDraft?.().trimEnd() ?? "";
      seedComposer([draft, result.draftText ?? visibleUserMessageText(message.text)].filter(Boolean).join("\n\n"));
      composerRef.current?.focus();
    } catch (error) {
      portsRef.current.notify?.(errorMessage(error));
    }
  }, [applyActionResult, client, composerRef, requireHost, seedComposer, sessionId]);

  return { threadTreeModal, closeThreadTree, openThreadTree, navigateThreadTree, forkFromTree, editFromMessage };
}
