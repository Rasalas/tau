import type { ThreadBackendKind } from "../shared/contracts.js";
import { readPersistedJson, writePersistedJson, type PersistedJsonLogger } from "./persisted-json.js";

const VERSION = 1;
/** A marker is a breadcrumb, not a transcript; a long prompt is stored clipped. */
const MAX_PROMPT_TEXT = 4_000;

/** A turn the host had accepted and had not finished when it stopped. */
export interface InFlightTurn {
  sessionId: string;
  cwd: string;
  turnId: string;
  backend: ThreadBackendKind;
  startedAt: number;
  prompt: { text: string; images?: number };
  /** The host process that recorded it; markers from before this field have none. */
  writer?: { pid: number };
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function decodeTurn(value: unknown): InFlightTurn | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  const prompt = entry.prompt as { text?: unknown; images?: unknown } | undefined;
  if (typeof entry.sessionId !== "string" || !entry.sessionId) return undefined;
  if (typeof entry.cwd !== "string" || typeof entry.turnId !== "string") return undefined;
  if (typeof entry.backend !== "string" || typeof entry.startedAt !== "number") return undefined;
  if (!prompt || typeof prompt.text !== "string") return undefined;
  const writer = entry.writer as { pid?: unknown } | undefined;
  return {
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    turnId: entry.turnId,
    backend: entry.backend as ThreadBackendKind,
    startedAt: entry.startedAt,
    prompt: {
      text: prompt.text,
      ...(typeof prompt.images === "number" ? { images: prompt.images } : {}),
    },
    ...(typeof writer?.pid === "number" ? { writer: { pid: writer.pid } } : {}),
  };
}

export interface TurnsInFlightOptions {
  /** `<userData>/turns-in-flight.json`; without one the markers only last for this run. */
  filePath?: string;
  logger?: PersistedJsonLogger;
  /** Replaceable for tests. */
  alive?: (pid: number) => boolean;
}

/**
 * Which threads were mid-turn, written beside the sessions rather than into
 * them: the session file is the runtime's, and a marker has to survive a host
 * that never got to close one. One entry per thread — a second turn replaces
 * the first, because only the newest can still be continued.
 */
export class TurnsInFlight {
  private readonly turns = new Map<string, InFlightTurn>();
  private pending: Promise<void> = Promise.resolve();
  private loaded = false;
  private frozen = false;

  constructor(private readonly options: TurnsInFlightOptions = {}) {}

  /**
   * Reads what the previous run left behind. Later calls return what is held.
   * A marker whose writer still runs is not this host's to reconcile: it stays
   * in the file and is left out of the answer.
   */
  async load(): Promise<readonly InFlightTurn[]> {
    if (this.loaded || !this.options.filePath) { this.loaded = true; return this.reconcilable(); }
    this.loaded = true;
    const read = await readPersistedJson<InFlightTurn[]>(this.options.filePath, {
      expectedVersion: VERSION,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      decode: (value) => {
        const turns = (value as { turns?: unknown })?.turns;
        if (!Array.isArray(turns)) return undefined;
        return turns.flatMap((entry) => { const turn = decodeTurn(entry); return turn ? [turn] : []; });
      },
    });
    for (const turn of read?.data ?? []) this.turns.set(turn.sessionId, turn);
    return this.reconcilable();
  }

  private reconcilable(): readonly InFlightTurn[] {
    const alive = this.options.alive ?? processAlive;
    return this.list().filter((turn) => {
      const writer = turn.writer?.pid;
      if (writer === undefined || writer === process.pid || !alive(writer)) return true;
      this.options.logger?.warn("turns-in-flight.writer-alive", `${turn.sessionId.slice(0, 8)} · pid ${writer}`);
      return false;
    });
  }

  list(): readonly InFlightTurn[] {
    return [...this.turns.values()];
  }

  get(sessionId: string): InFlightTurn | undefined {
    return this.turns.get(sessionId);
  }

  /**
   * Stops recording and forgetting. The host is going away, and the aborts its
   * own shutdown fires would otherwise read as turns that finished — which is
   * exactly the case these markers exist for.
   */
  freeze(): void {
    this.frozen = true;
  }

  record(turn: InFlightTurn): void {
    if (this.frozen) return;
    this.turns.set(turn.sessionId, {
      ...turn,
      writer: { pid: process.pid },
      prompt: { ...turn.prompt, text: turn.prompt.text.slice(0, MAX_PROMPT_TEXT) },
    });
    this.persist();
  }

  /** Forgets the thread's marker. With a `turnId` only that turn's, so an older turn's end never clears a newer one. */
  clear(sessionId: string, turnId?: string): void {
    if (this.frozen) return;
    const held = this.turns.get(sessionId);
    if (!held || (turnId !== undefined && held.turnId !== turnId)) return;
    this.turns.delete(sessionId);
    this.persist();
  }

  /** Resolves once every write this store has scheduled has landed. */
  flush(): Promise<void> {
    return this.pending;
  }

  private persist(): void {
    const path = this.options.filePath;
    if (!path) return;
    const turns = this.list();
    this.pending = this.pending
      .catch(() => undefined)
      .then(() => writePersistedJson(path, VERSION, { turns }, this.options.logger ? { logger: this.options.logger } : {}))
      .catch(() => undefined);
  }
}
