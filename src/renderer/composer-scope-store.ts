import type { UiPromptAttachment } from "../shared/contracts";
import { readComposerDraft } from "./draft-store";

declare const draftKeyBrand: unique symbol;
export type DraftKey = string & { readonly [draftKeyBrand]: true };
export type ComposerScope = DraftKey;

export function createDraftKey(storageKey?: string): DraftKey {
  return (storageKey ?? "thread:default") as DraftKey;
}

export type PendingAttachment = UiPromptAttachment & { id: number; previewUrl: string };

export interface ComposerScopeState {
  draft: string;
  revision: number;
  attachments: PendingAttachment[];
  error?: string;
  errorSubmissionId?: number;
  queue: Promise<void>;
  pendingSubmissions: Map<number, { attachmentIds: ReadonlySet<number>; revision: number }>;
}

export class ComposerScopeStore {
  private readonly states = new Map<ComposerScope, ComposerScopeState>();

  ensure(scope: ComposerScope): ComposerScopeState {
    const existing = this.states.get(scope);
    if (existing) return existing;
    const created: ComposerScopeState = {
      draft: readComposerDraft(window.localStorage, scope),
      revision: 0,
      attachments: [],
      queue: Promise.resolve(),
      pendingSubmissions: new Map(),
    };
    this.states.set(scope, created);
    return created;
  }
}
