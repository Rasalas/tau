/** Thread Rail's optional settlement service; the composer strip claims its note while drawn. */
export const SETTLEMENT_SERVICE = "tau.thread-rail/settlement";
export interface Settlement {
  settledAt?: number;
  settledBy?: string;
  settledForRequest?: string;
}
export interface SettlementService {
  get(threadId: string): Settlement | undefined;
  subscribe(listener: () => void): () => void;
  reopen(threadId: string): void;
  claimNote(threadId: string): () => void;
}
export class SettlementSource {
  private service?: SettlementService;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.service;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(service: SettlementService | undefined) { this.service = service; for (const listener of this.listeners) listener(); }
}
