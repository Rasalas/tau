import type { Plugin } from "vite";

// Only comments that open with the tag count, so a "/*" inside a string cannot start a match.
const LEGAL_COMMENT = /\/\*[*!]?[\s*]*@(?:license|preserve)\b[\s\S]*?\*\//gu;

/**
 * Blanks every repeat of a legal comment already present earlier in the chunk.
 * Each icon module carries the same notice; one copy per chunk keeps it. The
 * blanks keep every line and column, so an existing source map stays valid.
 */
export function blankRepeatedLegalComments(code: string): string {
  const seen = new Set<string>();
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

/** Runs before the minifier, which then drops the blanks. */
export function dedupeLegalComments(): Plugin {
  return {
    name: "tau-dedupe-legal-comments",
    apply: "build",
    enforce: "post",
    renderChunk(code) {
      const result = blankRepeatedLegalComments(code);
      return result === code ? null : { code: result, map: null };
    },
  };
}
