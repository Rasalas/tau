import { useCallback, useEffect, useRef, useState } from "react";
import type { ExtensionUiPrompt } from "../../shared/contracts";
import type { ComposerScope, ComposerScopeStore, PendingAttachment } from "../../workbench/composer-scope-store";

/** A question waits until the user has not typed for this long, so keys meant for the draft never answer it. */
export const PROMPT_SETTLE_MS = 1500;

interface StashedDraft {
  scope: ComposerScope;
  draft: string;
  attachments: PendingAttachment[];
}

/**
 * When a question takes the composer: at once while the user is idle, else
 * after a pause in typing. The draft and its files are set aside when it
 * does and come back once no question is left, or when the composer moves
 * to another thread.
 */
export function usePromptArrival({ prompt, scope, scopeStore, setDraft }: {
  prompt?: ExtensionUiPrompt;
  scope: ComposerScope;
  scopeStore: ComposerScopeStore;
  /** Writes the field and the stored draft of the current scope. */
  setDraft(draft: string): void;
}): {
  /** The field answers the question now. */
  armed: boolean;
  /** A question is here but waits for the typing to stop. */
  waiting: boolean;
  /** A draft is set aside until the questions are answered. */
  stashed: boolean;
  /** Call on every key in the field. */
  noteTyping(): void;
} {
  const lastTypedAt = useRef(0);
  const [armedId, setArmedId] = useState<string>();
  // Set while questions follow one another; only the first of them sets the draft aside.
  const answering = useRef<ComposerScope | undefined>(undefined);
  const [stash, setStash] = useState<StashedDraft>();
  const stashRef = useRef(stash);
  stashRef.current = stash;
  const setDraftRef = useRef(setDraft);
  setDraftRef.current = setDraft;
  const promptId = prompt && prompt.answerElsewhere !== true ? prompt.id : undefined;
  const prefill = prompt?.prefill;

  useEffect(() => {
    if (!promptId) { answering.current = undefined; return undefined; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      const current = scopeStore.getSnapshot(scope);
      if (answering.current !== scope && !stashRef.current && (current.draft.trim() || current.attachments.length > 0)) {
        const next = { scope, draft: current.draft, attachments: [...current.attachments] };
        stashRef.current = next;
        setStash(next);
        // The stored draft stays as it was, so a reload before the answer loses nothing.
        scopeStore.setDraft(scope, "");
        scopeStore.setAttachments(scope, []);
      }
      answering.current = scope;
      if (prefill) setDraftRef.current(prefill);
      setArmedId(promptId);
    };
    const settle = () => {
      const idle = Date.now() - lastTypedAt.current;
      if (idle >= PROMPT_SETTLE_MS) arm();
      else timer = setTimeout(settle, PROMPT_SETTLE_MS - idle);
    };
    settle();
    return () => { if (timer) clearTimeout(timer); };
  }, [prefill, promptId, scope, scopeStore]);

  // No question left, or another thread's composer: the draft goes back where it came from.
  useEffect(() => {
    if (!stash || (promptId && stash.scope === scope)) return;
    const current = scopeStore.getSnapshot(stash.scope);
    const draft = current.draft.trim() ? `${stash.draft}\n${current.draft}` : stash.draft;
    if (stash.scope === scope) setDraftRef.current(draft);
    else scopeStore.setDraft(stash.scope, draft);
    scopeStore.setAttachments(stash.scope, [...stash.attachments, ...current.attachments]);
    stashRef.current = undefined;
    setStash(undefined);
  }, [promptId, scope, scopeStore, stash]);

  const noteTyping = useCallback(() => { lastTypedAt.current = Date.now(); }, []);
  const armed = Boolean(promptId) && armedId === promptId;
  return { armed, waiting: Boolean(promptId) && !armed, stashed: Boolean(stash), noteTyping };
}
