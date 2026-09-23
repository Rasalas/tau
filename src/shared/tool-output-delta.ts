/**
 * What changed between two versions of a running tool's output. Output grows
 * at its end; once the host keeps only its tail, it also loses part of its
 * head behind a fixed marker. Both are a delta: keep `keep` characters, drop
 * the `drop` after them, append `text`.
 */
export interface ToolOutputDelta {
  keep: number;
  drop: number;
  text: string;
}

/** Characters of the new output used to find where the old tail continues. */
const PROBE_LENGTH = 64;
const PROBE_ATTEMPTS = 4;

/** `previous` turned into the output the delta describes; undefined when it cannot apply. */
export function applyToolOutputDelta(previous: string, delta: ToolOutputDelta): string | undefined {
  if (delta.keep + delta.drop > previous.length) return undefined;
  return previous.slice(0, delta.keep) + previous.slice(delta.keep + delta.drop) + delta.text;
}

/**
 * The delta from `previous` to `next`, or undefined when sending `next` whole
 * is as cheap or when `next` is not a continuation of `previous`.
 */
export function toolOutputDelta(previous: string, next: string): ToolOutputDelta | undefined {
  if (next.startsWith(previous)) return worthIt({ keep: previous.length, drop: 0, text: next.slice(previous.length) }, next);
  const keep = commonPrefixLength(previous, next);
  const probe = next.slice(keep, keep + PROBE_LENGTH);
  if (probe.length === 0) return undefined;
  let at = previous.indexOf(probe, keep);
  for (let attempt = 0; at !== -1 && attempt < PROBE_ATTEMPTS; attempt += 1) {
    // The rest of `previous` from `at` must reappear right after the kept head.
    if (next.startsWith(previous.slice(at), keep)) {
      return worthIt({ keep, drop: at - keep, text: next.slice(keep + previous.length - at) }, next);
    }
    at = previous.indexOf(probe, at + 1);
  }
  return undefined;
}

function worthIt(delta: ToolOutputDelta, next: string): ToolOutputDelta | undefined {
  return delta.text.length < next.length / 2 ? delta : undefined;
}

/** `next` as a change to `previous`: their common head kept, the rest replaced. Always applies. */
export function replaceTail(previous: string, next: string): ToolOutputDelta {
  const keep = commonPrefixLength(previous, next);
  return { keep, drop: previous.length - keep, text: next.slice(keep) };
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}
