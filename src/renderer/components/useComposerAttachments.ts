import { useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";
import type {
  ComposerScope,
  ComposerScopeReference,
  ComposerScopeStore,
  PendingAttachment,
} from "../../workbench/composer-scope-store";
import {
  attachmentPolicyMessage,
  MAX_ATTACHMENTS,
  selectAttachmentCandidates,
} from "../../shared/prompt-attachment-limits";
import { IMAGE_INPUT_UNAVAILABLE_MESSAGE } from "../../shared/thread-drop";
import { errorMessage } from "../../workbench/error-message";
import { readImage } from "./ComposerAttachments";

export interface ComposerAttachmentHandle {
  addFiles(files: FileList | readonly File[]): Promise<void>;
}

export interface UseComposerAttachmentsOptions {
  scopeStore: ComposerScopeStore;
  scope: ComposerScope;
  attachments: readonly PendingAttachment[];
  supportsImageInput: boolean;
  attachmentRef?: RefObject<ComposerAttachmentHandle | null>;
}

export interface UseComposerAttachmentsResult {
  preview: PendingAttachment | undefined;
  previewId: number | undefined;
  setPreviewId: (id: number | undefined) => void;
  clearPreviewForScope: (submittedScope: ComposerScope) => void;
  addFiles: (files: FileList | readonly File[]) => Promise<void>;
  removeAttachment: (id: number) => void;
}

export function useComposerAttachments({
  scopeStore,
  scope,
  attachments,
  supportsImageInput,
  attachmentRef,
}: UseComposerAttachmentsOptions): UseComposerAttachmentsResult {
  const [previewId, setPreviewId] = useState<number | undefined>(undefined);
  const activeAttachmentScopeRef = useRef<ComposerScope>(scope);
  const preview = attachments.find((attachment) => attachment.id === previewId);

  useEffect(() => {
    const previousScope = activeAttachmentScopeRef.current;
    if (previousScope === scope) return;
    activeAttachmentScopeRef.current = scope;
    setPreviewId(undefined);
  }, [scope]);

  const clearPreviewForScope = useCallback((submittedScope: ComposerScope) => {
    if (activeAttachmentScopeRef.current === submittedScope) setPreviewId(undefined);
  }, []);

  const processFiles = useCallback(async (
    files: FileList | readonly File[],
    scopeRef: ComposerScopeReference,
    capability: boolean,
    generation: number,
  ) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const state = scopeStore.getSnapshot(scopeRef.scope);
    if (!capability) {
      scopeStore.setAttachmentError(scopeRef.scope, IMAGE_INPUT_UNAVAILABLE_MESSAGE, generation);
      return;
    }
    const policy = selectAttachmentCandidates(
      incoming.map((file) => ({ item: file, name: file.name, mimeType: file.type, size: file.size })),
      state.attachments,
    );
    const validCandidates = policy.accepted.map((candidate) => candidate.item);
    const firstError = policy.rejected[0] ? attachmentPolicyMessage(policy.rejected[0]) : undefined;
    const results = await Promise.allSettled(validCandidates.map(readImage));
    const accepted = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const rejection = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    const error = firstError ?? (rejection ? errorMessage(rejection.reason) : undefined);
    scopeStore.setAttachmentError(scopeRef.scope, error, generation);
    if (accepted.length > 0) {
      scopeStore.addAttachments(scopeRef.scope, accepted, MAX_ATTACHMENTS);
    }
  }, [scopeStore]);

  const addFiles = useCallback((files: FileList | readonly File[]) => {
    // DataTransfer.files is a live FileList and may be emptied once the drop
    // event returns. Snapshot it before entering the asynchronous queue.
    const fileSnapshot = Array.from(files);
    const scopeRef = scopeStore.createScopeReference(scope);
    const state = scopeStore.getSnapshot(scope);
    const previous = state.attachmentProcessing;
    let generation = 0;
    const operation = previous
      .then(() => processFiles(fileSnapshot, scopeRef, supportsImageInput, generation))
      .finally(() => scopeStore.releaseScopeReference(scopeRef));
    generation = scopeStore.setAttachmentProcessing(scope, operation);
    return operation;
  }, [scope, processFiles, scopeStore, supportsImageInput]);

  useImperativeHandle(attachmentRef, () => ({ addFiles }), [addFiles]);

  const removeAttachment = useCallback((id: number) => {
    scopeStore.removeAttachment(scope, id);
  }, [scope, scopeStore]);

  return {
    preview,
    previewId,
    setPreviewId,
    clearPreviewForScope,
    addFiles,
    removeAttachment,
  };
}
