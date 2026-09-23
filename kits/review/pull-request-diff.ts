import type { UiDiffHunk, UiDiffLine, UiFileDiff } from "tau";

/** A block larger than this is left as it is: the pairing below is quadratic. */
const MAX_BLOCK_CELLS = 250_000;

const bare = (text: string) => text.replace(/\s+/gu, "");

/**
 * One run of removed lines and the added lines after it, with the lines that
 * differ only in whitespace turned into context, as `git diff -w` would show
 * them. The pairing is a longest common subsequence over the lines without
 * their whitespace, so moved blocks stay changes.
 */
function settleBlock(removed: UiDiffLine[], added: UiDiffLine[]): UiDiffLine[] {
  if (removed.length === 0 || added.length === 0 || removed.length * added.length > MAX_BLOCK_CELLS) return [...removed, ...added];
  const left = removed.map((line) => bare(line.text));
  const right = added.map((line) => bare(line.text));
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const out: UiDiffLine[] = [];
  const pendingRemoved: UiDiffLine[] = [];
  const pendingAdded: UiDiffLine[] = [];
  const flush = () => { out.push(...pendingRemoved.splice(0), ...pendingAdded.splice(0)); };
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      flush();
      // The new text is what the file says now; both numbers keep comments anchored.
      out.push({ kind: "context", oldLine: removed[i]!.oldLine!, newLine: added[j]!.newLine!, text: added[j]!.text });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      pendingRemoved.push(removed[i]!);
      i += 1;
    } else {
      pendingAdded.push(added[j]!);
      j += 1;
    }
  }
  pendingRemoved.push(...removed.slice(i));
  pendingAdded.push(...added.slice(j));
  flush();
  return out;
}

function settleHunk(hunk: UiDiffHunk): UiDiffHunk {
  const lines: UiDiffLine[] = [];
  let removed: UiDiffLine[] = [];
  let added: UiDiffLine[] = [];
  const close = () => {
    lines.push(...settleBlock(removed, added));
    removed = [];
    added = [];
  };
  for (const line of hunk.lines) {
    if (line.kind === "removed") {
      if (added.length > 0) close();
      removed.push(line);
    } else if (line.kind === "added") {
      added.push(line);
    } else {
      close();
      lines.push(line);
    }
  }
  close();
  return { ...hunk, lines };
}

/**
 * A pull request's diff with whitespace-only changes shown as unchanged
 * lines, since neither `gh` nor `glab` hands out a `-w` diff. Counts follow
 * what is left; a file whose every change was whitespace keeps its hunks as
 * context and says so.
 */
export function hideWhitespace(diff: UiFileDiff): UiFileDiff {
  if (diff.hunks.length === 0) return diff;
  const hunks = diff.hunks.map(settleHunk);
  let added = 0;
  let removed = 0;
  for (const line of hunks.flatMap((hunk) => hunk.lines)) {
    if (line.kind === "added") added += 1;
    else if (line.kind === "removed") removed += 1;
  }
  if (added === diff.added && removed === diff.removed) return diff;
  return { ...diff, hunks, added, removed, ...(added + removed === 0 && !diff.note ? { note: "Only whitespace changed in this file." } : {}) };
}
