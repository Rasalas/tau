export interface PromptHistoryOptions {
  maxEntries?: number;
  initialEntries?: readonly string[];
}

/**
 * Shell-like prompt history for the composer.
 * Tracks previously submitted user prompts and allows cycling back and forward
 * while preserving the in-progress draft.
 */
export class PromptHistory {
  private entries: string[] = [];
  private readonly maxEntries: number;
  private cursor = -1;
  private currentDraft = "";

  constructor(options: PromptHistoryOptions = {}) {
    this.maxEntries = options.maxEntries ?? 100;
    if (options.initialEntries) {
      for (const entry of options.initialEntries) {
        this.record(entry);
      }
    }
  }

  getEntries(): readonly string[] {
    return this.entries;
  }

  record(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Deduplicate consecutive identical prompts
    if (this.entries.length > 0 && this.entries[this.entries.length - 1] === trimmed) {
      this.resetCursor();
      return;
    }
    this.entries.push(trimmed);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    this.resetCursor();
  }

  resetCursor(): void {
    this.cursor = -1;
    this.currentDraft = "";
  }

  get isNavigating(): boolean {
    return this.cursor !== -1;
  }

  /**
   * Navigates to an older entry in prompt history.
   * When starting navigation, saves `currentInput` as the draft to restore later.
   */
  navigateBack(currentInput: string): string | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.cursor === -1) {
      this.currentDraft = currentInput;
      this.cursor = this.entries.length - 1;
      return this.entries[this.cursor];
    }
    if (this.cursor > 0) {
      this.cursor -= 1;
      return this.entries[this.cursor];
    }
    return this.entries[0];
  }

  /**
   * Navigates to a newer entry in prompt history.
   * When moving past the newest entry, restores the saved draft and resets the cursor.
   */
  navigateForward(): string | undefined {
    if (this.cursor === -1) return undefined;
    if (this.cursor < this.entries.length - 1) {
      this.cursor += 1;
      return this.entries[this.cursor];
    }
    const draft = this.currentDraft;
    this.resetCursor();
    return draft;
  }
}
