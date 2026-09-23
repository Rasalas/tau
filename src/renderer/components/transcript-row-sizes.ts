import type { UiMessage } from "../../shared/contracts";
import type { TranscriptDetail } from "../../workbench/transcript-folding";

const kindNames = new Map<string, readonly string[]>();

/** What a row's height mostly depends on: its role, thinking, whether it holds a turn's work. */
export function transcriptRowKind(message: UiMessage, hasActivities: boolean, detail?: TranscriptDetail): string {
  let names = kindNames.get(message.role);
  if (!names) {
    const role = message.role;
    names = [role, `${role}+thinking`, `${role}+work`, `${role}+thinking+work`];
    kindNames.set(role, names);
  }
  return names[(message.thinking && detail !== "focused" ? 1 : 0) + (hasActivities ? 2 : 0)]!;
}

/** Before any row of a kind is measured; roughly one line of text plus the row's chrome. */
const DEFAULT_ROW_SIZE = 120;

interface MeasuredRow {
  kind: string;
  size: number;
  /** The newest layout generation that started before this size was known. */
  generation: number;
}

/**
 * Row heights as the virtualizer measured them, and a mean per row kind for
 * rows it has not measured yet. A layout generation says which sizes a given
 * layout already used.
 */
export class TranscriptRowSizes {
  private generation = 0;
  private readonly rows = new Map<string, MeasuredRow>();
  private readonly kinds = new Map<string, { total: number; count: number }>();

  /** Call once per layout, before the virtualizer reads any size. */
  beginLayout(): number {
    this.generation += 1;
    return this.generation;
  }

  record(key: string, kind: string, size: number): void {
    const previous = this.rows.get(key);
    if (previous?.size === size && previous.kind === kind) return;
    if (previous) this.remove(previous);
    const stats = this.kinds.get(kind) ?? { total: 0, count: 0 };
    stats.total += size;
    stats.count += 1;
    this.kinds.set(kind, stats);
    this.rows.set(key, { kind, size, generation: previous?.generation ?? this.generation });
  }

  /** The measured size of `key`, else the mean of its kind. */
  size(key: string, kind: string): number {
    const measured = this.rows.get(key)?.size;
    if (measured !== undefined) return measured;
    const stats = this.kinds.get(kind);
    return stats && stats.count > 0 ? Math.round(stats.total / stats.count) : DEFAULT_ROW_SIZE;
  }

  /** True when the layout of `generation` placed `key` at its measured size. */
  measuredBefore(key: string, generation: number): boolean {
    const row = this.rows.get(key);
    return row !== undefined && row.generation < generation;
  }

  private remove(row: MeasuredRow): void {
    const stats = this.kinds.get(row.kind);
    if (!stats) return;
    stats.total -= row.size;
    stats.count -= 1;
  }
}
