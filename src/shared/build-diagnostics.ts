import type { BuildDiagnostic } from "./contracts.js";

/** How many errors a message spells out; the rest are counted. */
const SHOWN = 5;

/** `desktop.tsx:12:7: Expected ";" but found "y"`: where, then what. */
export function diagnosticLine(diagnostic: BuildDiagnostic): string {
  const where = diagnostic.file
    ? [diagnostic.file, diagnostic.line, diagnostic.column].filter((part) => part !== undefined).join(":")
    : undefined;
  return where ? `${where}: ${diagnostic.text}` : diagnostic.text;
}

/** Each error with its source line and a caret under the column, the way esbuild prints them. */
export function formatBuildDiagnostics(diagnostics: readonly BuildDiagnostic[]): string {
  const lines: string[] = [];
  for (const diagnostic of diagnostics.slice(0, SHOWN)) {
    lines.push(diagnosticLine(diagnostic));
    if (diagnostic.lineText !== undefined && diagnostic.column !== undefined) {
      const text = diagnostic.lineText.replace(/\t/gu, " ");
      lines.push(`  ${text}`, `  ${" ".repeat(Math.min(diagnostic.column, text.length))}^`);
    }
  }
  if (diagnostics.length > SHOWN) lines.push(`…and ${diagnostics.length - SHOWN} more.`);
  return lines.join("\n");
}
