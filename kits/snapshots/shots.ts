import type { SnapShotAccessibility, SnapShotMeta } from "./protocol.js";

/** One SnapShot in a draft. `meta` arrives from the host; `missing` when the host no longer has it. */
export interface Shot {
  id: string;
  meta?: SnapShotMeta;
  missing?: boolean;
}

/** A capture read in full, kept while its chip lives. */
export interface ShotContent {
  url: string;
  data: string;
  mimeType: string;
  accessibility?: SnapShotAccessibility;
}

type Persist = (value: unknown) => void;

/**
 * The SnapShots of every draft, by the scope core names the draft with. Shots
 * being sent are hidden until core says whether the prompt went; a draft
 * persists only the ids, the host keeps the rest.
 */
export class ShotStore {
  private readonly scopes = new Map<string, Shot[]>();
  private readonly sending = new Map<string, Shot[]>();
  private readonly persisters = new Map<string, Persist>();
  private readonly listeners = new Set<() => void>();
  private readonly contents = new Map<string, ShotContent>();
  /** The draft of the composer on screen; where a new capture lands. */
  activeScope: string | undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  list(scope: string): readonly Shot[] {
    return this.scopes.get(scope) ?? EMPTY;
  }

  find(id: string): Shot | undefined {
    for (const shots of [...this.scopes.values(), ...this.sending.values()]) {
      const shot = shots.find((entry) => entry.id === id);
      if (shot) return shot;
    }
    return undefined;
  }

  /** Brings back the ids a draft persisted, once; answers the ones whose metadata is still to be read. */
  hydrate(scope: string, persisted: unknown, persist: Persist): string[] {
    this.persisters.set(scope, persist);
    if (this.scopes.has(scope) || this.sending.has(scope)) return [];
    const ids = decodeShots(persisted);
    if (ids.length === 0) return [];
    this.scopes.set(scope, ids.map((id) => ({ id })));
    this.changed(scope, false);
    return ids;
  }

  add(scope: string, meta: SnapShotMeta): void {
    if (this.list(scope).some((shot) => shot.id === meta.id)) return;
    this.scopes.set(scope, [...this.list(scope), { id: meta.id, meta }]);
    this.changed(scope);
  }

  /** Metadata the host answered for hydrated ids; `null` marks one it no longer has. */
  resolve(answers: ReadonlyMap<string, SnapShotMeta | null>): void {
    let touched = false;
    for (const [scope, shots] of this.scopes) {
      const next = shots.map((shot) => {
        if (!answers.has(shot.id)) return shot;
        touched = true;
        const meta = answers.get(shot.id);
        return meta ? { id: shot.id, meta } : { id: shot.id, missing: true };
      });
      this.scopes.set(scope, next);
    }
    if (touched) this.emit();
  }

  remove(scope: string, id: string): boolean {
    const shots = this.list(scope);
    if (!shots.some((shot) => shot.id === id)) return false;
    this.scopes.set(scope, shots.filter((shot) => shot.id !== id));
    this.contents.delete(id);
    this.changed(scope);
    return true;
  }

  beginSend(scope: string): readonly Shot[] {
    const shots = [...this.list(scope)];
    if (shots.length === 0) return shots;
    this.sending.set(scope, [...this.sending.get(scope) ?? [], ...shots]);
    this.scopes.set(scope, []);
    this.changed(scope, false);
    return shots;
  }

  /** Answers the shots that went, so the host can let go of them; a refused prompt puts them back. */
  settle(scope: string, accepted: boolean): readonly Shot[] {
    const sent = this.sending.get(scope) ?? [];
    this.sending.delete(scope);
    if (sent.length === 0) return [];
    if (accepted) for (const shot of sent) this.contents.delete(shot.id);
    else this.scopes.set(scope, [...sent, ...this.list(scope)]);
    this.changed(scope);
    return accepted ? sent : [];
  }

  content(id: string): ShotContent | undefined {
    return this.contents.get(id);
  }

  setContent(id: string, content: ShotContent): void {
    this.contents.set(id, content);
    this.emit();
  }

  private changed(scope: string, persist = true): void {
    if (persist && !this.sending.has(scope)) this.persisters.get(scope)?.(encodeShots(this.list(scope)));
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const EMPTY: readonly Shot[] = [];

export function encodeShots(shots: readonly Shot[]): unknown {
  const ids = shots.filter((shot) => !shot.missing).map((shot) => shot.id);
  return ids.length > 0 ? { version: 1, ids } : undefined;
}

export function decodeShots(value: unknown): string[] {
  const ids = (value as { ids?: unknown } | undefined)?.ids;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && /^snap-[a-z0-9-]+$/u.test(id)) : [];
}
