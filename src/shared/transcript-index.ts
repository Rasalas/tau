import type { UiMessage } from "./contracts.js";

export type TranscriptMessageUpdate = (message: UiMessage) => UiMessage | undefined;

function lookupFieldsChanged(current: UiMessage, next: UiMessage): boolean {
  if (current.id !== next.id || current.role !== next.role) return true;
  if (current.role !== "user" && next.role !== "user") return false;
  return current.text !== next.text
    || current.timestamp !== next.timestamp
    || current.sourceEntryId !== next.sourceEntryId
    || current.clientTurnId !== next.clientTurnId
    || current.clientMessageId !== next.clientMessageId;
}

/** Keep this deliberately aligned with the context-meter heuristic in App. */
export function estimateTranscriptTokens(message: Pick<UiMessage, "text" | "thinking">): number {
  return Math.ceil(message.text.length / 4) + Math.ceil((message.thinking ?? "").length / 4);
}

/**
 * Delta-backed index for a live transcript. Snapshot replacement and prepend
 * operations rebuild the lookup once; streaming deltas update the stable
 * snapshot by ID without copying or scanning the complete history on every
 * animation frame. Consumers use `revision` to render the changed snapshot.
 */
export class TranscriptMessageIndex {
  private records: UiMessage[];
  private readonly positions = new Map<string, number>();
  private tokenEstimateValue = 0;
  private userRevisionValue = 0;
  private lookupRevisionValue = 0;
  private revisionValue = 0;

  constructor(records: readonly UiMessage[] = []) {
    this.records = [...records];
    this.rebuildPositions();
    this.recalculateAggregates();
  }

  get messages(): UiMessage[] {
    return this.records;
  }

  get size(): number {
    return this.records.length;
  }

  /** Aggregate used by context UI; deltas adjust it by ID instead of rescanning history. */
  get tokenEstimate(): number {
    return this.tokenEstimateValue;
  }

  /** Changes only when a user-message membership/content can affect reconciliation. */
  get userRevision(): number {
    return this.userRevisionValue;
  }

  /** Changes only when the user-message lookup can become stale. */
  get lookupRevision(): number {
    return this.lookupRevisionValue;
  }

  /** Increments for every visible record update, including assistant deltas. */
  get revision(): number {
    return this.revisionValue;
  }

  has(id: string): boolean {
    return this.positions.has(id);
  }

  get(id: string): UiMessage | undefined {
    const index = this.positions.get(id);
    return index === undefined ? undefined : this.records[index];
  }

  indexOf(id: string): number {
    return this.positions.get(id) ?? -1;
  }

  replace(records: readonly UiMessage[]): UiMessage[] {
    this.records = [...records];
    this.rebuildPositions();
    this.recalculateAggregates();
    this.userRevisionValue += 1;
    this.lookupRevisionValue += 1;
    this.revisionValue += 1;
    return this.records;
  }

  append(record: UiMessage): UiMessage[] {
    if (this.positions.has(record.id)) return this.update(record.id, () => record);
    this.positions.set(record.id, this.records.length);
    this.records = [...this.records, record];
    this.tokenEstimateValue += estimateTranscriptTokens(record);
    if (record.role === "user") this.userRevisionValue += 1;
    this.lookupRevisionValue += 1;
    this.revisionValue += 1;
    return this.records;
  }

  prepend(records: readonly UiMessage[]): UiMessage[] {
    if (records.length === 0) return this.records;
    this.records = [...records, ...this.records];
    this.rebuildPositions();
    this.recalculateAggregates();
    if (records.some((record) => record.role === "user")) this.userRevisionValue += 1;
    this.lookupRevisionValue += 1;
    this.revisionValue += 1;
    return this.records;
  }

  update(id: string, updater: TranscriptMessageUpdate): UiMessage[] {
    const index = this.positions.get(id);
    if (index === undefined) return this.records;
    const current = this.records[index];
    const next = updater(current);
    if (!next || next === current) return this.records;
    // Keep the snapshot array stable. App/VirtualTranscript are explicitly
    // driven by `revision`, so a streaming update does not pay O(history) to
    // create a new array merely to replace one active record.
    this.records[index] = next;
    this.tokenEstimateValue += estimateTranscriptTokens(next) - estimateTranscriptTokens(current);
    if (current.role === "user" || next.role === "user") this.userRevisionValue += 1;
    if (lookupFieldsChanged(current, next)) this.lookupRevisionValue += 1;
    if (next.id !== id) this.rebuildPositions();
    this.revisionValue += 1;
    return this.records;
  }

  updateMany(updates: ReadonlyMap<string, TranscriptMessageUpdate>): UiMessage[] {
    if (updates.size === 0) return this.records;
    let tokenDelta = 0;
    let userChanged = false;
    let lookupChanged = false;
    let positionsChanged = false;
    let changed = false;
    for (const [id, updater] of updates) {
      const index = this.positions.get(id);
      if (index === undefined) continue;
      const current = this.records[index];
      const next = updater(current);
      if (!next || next === current) continue;
      this.records[index] = next;
      changed = true;
      if (next.id !== current.id || next.id !== id) positionsChanged = true;
      tokenDelta += estimateTranscriptTokens(next) - estimateTranscriptTokens(current);
      if (current.role === "user" || next.role === "user") userChanged = true;
      if (lookupFieldsChanged(current, next)) lookupChanged = true;
    }
    if (changed) {
      if (positionsChanged) this.rebuildPositions();
      this.tokenEstimateValue += tokenDelta;
      if (userChanged) this.userRevisionValue += 1;
      if (lookupChanged) this.lookupRevisionValue += 1;
      this.revisionValue += 1;
    }
    // Ordinary deltas preserve IDs and therefore keep every existing position
    // valid. If a caller reconciles an ID in a batch, rebuild once after the
    // batch rather than making each update scan the transcript.
    return this.records;
  }

  remove(id: string): UiMessage[] {
    const index = this.positions.get(id);
    if (index === undefined) return this.records;
    const removed = this.records[index];
    this.records = this.records.filter((_, at) => at !== index);
    this.rebuildPositions();
    this.tokenEstimateValue -= estimateTranscriptTokens(removed);
    if (removed.role === "user") this.userRevisionValue += 1;
    this.lookupRevisionValue += 1;
    this.revisionValue += 1;
    return this.records;
  }

  private rebuildPositions(): void {
    this.positions.clear();
    this.records.forEach((record, index) => this.positions.set(record.id, index));
  }

  private recalculateAggregates(): void {
    this.tokenEstimateValue = this.records.reduce((total, record) => total + estimateTranscriptTokens(record), 0);
  }
}
