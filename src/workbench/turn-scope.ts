import type { TranscriptTurnStart } from "./transcript-navigation";

/** The turn marker shared by submission and host-update handling. */
export interface TranscriptTurnPort {
  current(): TranscriptTurnStart | undefined;
  set(next: TranscriptTurnStart | undefined, expectedTurnId?: string): boolean;
}

/** Owns turn identity checks and the marker's lifetime across navigation. */
export class TurnScopeController implements TranscriptTurnPort {
  private marker: TranscriptTurnStart | undefined;
  private committedScopeKey: string;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly currentScopeKey: () => string) {
    this.committedScopeKey = currentScopeKey();
  }

  current = (): TranscriptTurnStart | undefined => this.marker;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set = (next: TranscriptTurnStart | undefined, expectedTurnId?: string): boolean => {
    if (expectedTurnId !== undefined && this.marker?.turnId !== expectedTurnId) return false;
    const scoped = next ? { ...next, scopeKey: next.scopeKey ?? this.currentScopeKey() } : undefined;
    if (this.marker !== scoped) {
      this.marker = scoped;
      for (const listener of this.listeners) listener();
    }
    return true;
  };

  /** Called when navigation commits; a promoted turn may already name its destination. */
  commitScope(scopeKey: string): void {
    if (this.committedScopeKey === scopeKey) return;
    this.committedScopeKey = scopeKey;
    if (this.marker?.scopeKey === scopeKey && this.marker.preserveAcrossSessionChange) return;
    this.set(undefined);
  }
}
