import type { Plugin, Rollup } from "vite";

// Only comments that open with the tag count, so a "/*" inside a string cannot start a match.
const LEGAL_COMMENT = /\/\*[*!]?[\s*]*@(?:license|preserve)\b[\s\S]*?\*\//gu;

/** The legal comments in `code`, in order. */
export function legalComments(code: string): string[] {
  return code.match(LEGAL_COMMENT) ?? [];
}

/**
 * Blanks every repeat of a legal comment already present earlier in the chunk,
 * and every copy of one in `kept`, which another chunk carries. The blanks keep
 * every line and column, so an existing source map stays valid.
 */
export function blankRepeatedLegalComments(code: string, kept: ReadonlySet<string> = new Set()): string {
  const seen = new Set<string>(kept);
  let changed = false;
  const result = code.replace(LEGAL_COMMENT, (comment) => {
    if (!seen.has(comment)) {
      seen.add(comment);
      return comment;
    }
    changed = true;
    return comment.replace(/[^\n]/gu, " ");
  });
  return changed ? result : code;
}

/**
 * Each icon module carries the same notice. The entry chunk, which every page
 * loads, keeps one copy; other chunks keep only notices the entry lacks, one
 * each. `third-party-licenses.json` ships every package's full licence text.
 * Runs before the minifier, which then drops the blanks.
 */
export function dedupeLegalComments(): Plugin {
  let entryNotices: { chunks: Record<string, Rollup.RenderedChunk>; notices: Set<string> } | undefined;
  return {
    name: "tau-dedupe-legal-comments",
    apply: "build",
    enforce: "post",
    renderChunk(code, chunk, _options, meta) {
      if (entryNotices?.chunks !== meta.chunks) {
        const notices = new Set<string>();
        for (const other of Object.values(meta.chunks)) {
          if (!other.isEntry) continue;
          for (const module of Object.values(other.modules)) for (const notice of legalComments(module.code ?? "")) notices.add(notice);
        }
        entryNotices = { chunks: meta.chunks, notices };
      }
      const result = blankRepeatedLegalComments(code, chunk.isEntry ? undefined : entryNotices.notices);
      return result === code ? null : { code: result, map: null };
    },
  };
}
