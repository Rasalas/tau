import { useCallback, useState, type RefObject } from "react";
import type { UiThreadTree } from "../shared/contracts";
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
  composerRef: RefObject<HTMLTextAreaElement | null>;
}

/**
 * Pi's `/tree`, `/fork` and `/clone` for the thread on screen: one modal, its
 * fetch and the two moves that close it. Only the modal is React; what it does
 * to the thread is `ThreadCommands`.
 */
export function useThreadTree(ports: ThreadTreePorts) {
  const [threadTreeModal, setThreadTreeModal] = useState<ThreadTreeModalState>();
  const closeThreadTree = useCallback(() => setThreadTreeModal(undefined), []);
  const { applyActionResult, client, composerRef, requireHost, seedComposer, sessionId } = ports;

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
    setThreadTreeModal((current) => current && { ...current, busy: true, error: undefined });
    try {
      applyActionResult(await client!.forkThread(entryId, sessionId()));
      setThreadTreeModal(undefined);
    } catch (error) {
      setThreadTreeModal((current) => current && { ...current, busy: false, error: errorMessage(error) });
    }
  }, [applyActionResult, client, sessionId]);

  return { threadTreeModal, closeThreadTree, openThreadTree, navigateThreadTree, forkFromTree };
}
