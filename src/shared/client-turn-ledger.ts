import type { ClientTurnIdentity } from "./contracts.js";

/** A portable observation understood by both the local host and the Pi bridge. */
export interface ClientTurnLedgerObservation extends Partial<ClientTurnIdentity> {
  sourceEntryId?: string;
  fingerprint?: string;
  text?: string;
  timestamp?: number;
}

export interface ClientTurnLedgerLimits {
  pendingPerScope: number;
  pendingTotal: number;
  rememberedPerScope: number;
  rememberedTotal: number;
}

export interface ClientTurnLedgerEntry {
  identity: ClientTurnIdentity;
  sequence: number;
  sessionId?: string;
  sourceEntryId?: string;
  fingerprint?: string;
  text?: string;
  timestamp?: number;
}

export interface ClientTurnLedgerSelection {
  entries: ClientTurnLedgerEntry[];
  entry: ClientTurnLedgerEntry;
  any: boolean;
}

const DEFAULT_LIMITS: ClientTurnLedgerLimits = {
  pendingPerScope: 64,
  pendingTotal: 1_024,
  rememberedPerScope: 256,
  rememberedTotal: 1_024,
};

/**
 * Shared bounded storage for renderer turn identities.
 *
 * The host and the `.pi` extension deliberately keep different observation
 * policies (local FIFO versus bridge fingerprint matching), but their
 * lifecycle is the same: pending entries are consumed or cancelled, settled
 * sessions are evicted, and remembered entries are only a bounded compatibility
 * ledger. Keeping this storage here prevents the two build seams from drifting
 * on caps, cleanup, and WeakMap ownership.
 */
export class ClientTurnLedgerStore {
  private readonly limits: ClientTurnLedgerLimits;
  private readonly pending = new Map<string, ClientTurnLedgerEntry[]>();
  private readonly pendingAny: ClientTurnLedgerEntry[] = [];
  private readonly remembered = new Map<string, ClientTurnLedgerEntry[]>();
  private readonly rawMessages = new WeakMap<object, ClientTurnIdentity>();
  private sequence = 0;

  constructor(limits: Partial<ClientTurnLedgerLimits> = {}) {
    this.limits = {
      ...DEFAULT_LIMITS,
      ...limits,
    };
  }

  enqueue(
    sessionId: string,
    identity: ClientTurnIdentity,
    metadata: Omit<ClientTurnLedgerObservation, keyof ClientTurnIdentity> = {},
  ): ClientTurnLedgerEntry {
    const entries = this.pending.get(sessionId) ?? [];
    const existing = entries.find((entry) => entry.identity.clientTurnId === identity.clientTurnId);
    if (existing) return existing;
    const entry: ClientTurnLedgerEntry = {
      identity,
      sequence: ++this.sequence,
      sessionId,
      ...metadata,
    };
    entries.push(entry);
    this.trimEntries(entries, this.limits.pendingPerScope);
    this.pending.set(sessionId, entries);
    this.trimPendingTotal();
    return entry;
  }

  enqueueAny(
    identity: ClientTurnIdentity,
    metadata: Omit<ClientTurnLedgerObservation, keyof ClientTurnIdentity> = {},
  ): ClientTurnLedgerEntry {
    const existing = this.pendingAny.find((entry) => entry.identity.clientTurnId === identity.clientTurnId);
    if (existing) return existing;
    const entry: ClientTurnLedgerEntry = {
      identity,
      sequence: ++this.sequence,
      ...metadata,
    };
    this.pendingAny.push(entry);
    this.trimEntries(this.pendingAny, this.limits.pendingPerScope);
    this.trimPendingTotal();
    return entry;
  }

  findPending(
    sessionId: string,
    predicate: (entry: ClientTurnLedgerEntry) => boolean,
    options: { preferAny?: boolean; bySequence?: boolean } = {},
  ): ClientTurnLedgerSelection | undefined {
    const sessionEntries = this.pending.get(sessionId) ?? [];
    const candidates: ClientTurnLedgerSelection[] = [];
    const add = (entries: ClientTurnLedgerEntry[], any: boolean) => {
      for (const entry of entries) if (predicate(entry)) candidates.push({ entries, entry, any });
    };
    if (options.preferAny) {
      add(this.pendingAny, true);
      add(sessionEntries, false);
    } else {
      add(sessionEntries, false);
      add(this.pendingAny, true);
    }
    if (options.bySequence) candidates.sort((left, right) => left.entry.sequence - right.entry.sequence);
    return candidates[0];
  }

  removePending(selection: ClientTurnLedgerSelection): void {
    const index = selection.entries.indexOf(selection.entry);
    if (index < 0) return;
    selection.entries.splice(index, 1);
    if (!selection.any && selection.entry.sessionId && selection.entries.length === 0) {
      this.pending.delete(selection.entry.sessionId);
    }
  }

  cancel(sessionId: string | undefined, identity: ClientTurnIdentity): void {
    if (sessionId) {
      const entries = this.pending.get(sessionId);
      this.removeIdentity(entries, identity);
      if (entries && entries.length === 0) this.pending.delete(sessionId);
      const remembered = this.remembered.get(sessionId);
      this.removeIdentity(remembered, identity);
      if (remembered && remembered.length === 0) this.remembered.delete(sessionId);
    } else {
      for (const [scope, entries] of this.remembered) {
        this.removeIdentity(entries, identity);
        if (entries.length === 0) this.remembered.delete(scope);
      }
    }
    this.removeIdentity(this.pendingAny, identity);
  }

  remember(
    sessionId: string,
    observation: ClientTurnLedgerObservation,
    identity: ClientTurnIdentity,
    rawMessage?: object,
  ): void {
    const entries = this.remembered.get(sessionId) ?? [];
    const existing = entries.find((entry) => entry.identity.clientTurnId === identity.clientTurnId);
    if (existing) {
      existing.sourceEntryId ??= observation.sourceEntryId;
      existing.fingerprint = observation.fingerprint || existing.fingerprint;
      existing.text = observation.text ?? existing.text;
      existing.timestamp = observation.timestamp ?? existing.timestamp;
    } else {
      entries.push({
        identity,
        sequence: ++this.sequence,
        sessionId,
        sourceEntryId: observation.sourceEntryId,
        fingerprint: observation.fingerprint,
        text: observation.text,
        timestamp: observation.timestamp,
      });
    }
    this.trimEntries(entries, this.limits.rememberedPerScope);
    this.remembered.set(sessionId, entries);
    this.trimRememberedTotal();
    if (rawMessage) this.rawMessages.set(rawMessage, identity);
  }

  identityForRaw(rawMessage: object): ClientTurnIdentity | undefined {
    return this.rawMessages.get(rawMessage);
  }

  rememberedEntries(sessionId: string): readonly ClientTurnLedgerEntry[] {
    return this.remembered.get(sessionId) ?? [];
  }

  clear(sessionId?: string, options: { preserveAny?: boolean } = {}): void {
    if (sessionId) {
      this.pending.delete(sessionId);
      this.remembered.delete(sessionId);
      return;
    }
    this.pending.clear();
    if (!options.preserveAny) this.pendingAny.length = 0;
    this.remembered.clear();
  }

  clearAny(): void {
    this.pendingAny.length = 0;
  }

  get pendingSize(): number {
    return this.pendingAny.length + [...this.pending.values()].reduce((total, entries) => total + entries.length, 0);
  }

  get rememberedSize(): number {
    return [...this.remembered.values()].reduce((total, entries) => total + entries.length, 0);
  }

  get size(): number {
    return this.pendingSize + this.rememberedSize;
  }

  private removeIdentity(entries: ClientTurnLedgerEntry[] | undefined, identity: ClientTurnIdentity): void {
    if (!entries) return;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index].identity.clientTurnId === identity.clientTurnId) entries.splice(index, 1);
    }
  }

  private trimEntries(entries: ClientTurnLedgerEntry[], limit: number): void {
    while (entries.length > limit) entries.shift();
  }

  private trimPendingTotal(): void {
    while (this.pendingSize > this.limits.pendingTotal) {
      if (this.pendingAny.length > 0) {
        this.pendingAny.shift();
        continue;
      }
      const oldest = this.pending.entries().next().value as [string, ClientTurnLedgerEntry[]] | undefined;
      if (!oldest) break;
      const [sessionId, entries] = oldest;
      entries.shift();
      if (entries.length === 0) this.pending.delete(sessionId);
    }
  }

  private trimRememberedTotal(): void {
    while (this.rememberedSize > this.limits.rememberedTotal) {
      const oldest = this.remembered.entries().next().value as [string, ClientTurnLedgerEntry[]] | undefined;
      if (!oldest) break;
      const [sessionId, entries] = oldest;
      entries.shift();
      if (entries.length === 0) this.remembered.delete(sessionId);
    }
  }
}
