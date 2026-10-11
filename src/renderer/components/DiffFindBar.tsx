import { useEffect, useRef } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from "lucide-react";
import { MAX_MATCHES } from "./diff-find";
import type { DiffFindController } from "./use-diff-find";
import "./diff-find.css";

/** The bar over a surface's diffs: a field, the count, the previous and next match and the three switches. */
export function DiffFindBar({ controller }: { controller: DiffFindController }) {
  const { query, matches, index, invalid, capped } = controller;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [controller.focus]);
  if (!controller.open) return null;
  const count = query.text === "" ? "" : invalid ? "Invalid pattern" : matches.length === 0 ? "No results" : `${index + 1} of ${matches.length}${capped ? "+" : ""}`;
  const toggle = (key: "caseSensitive" | "wholeWord" | "regex", label: string, icon: React.ReactNode) => (
    <button type="button" className={`icon-button compact${query[key] ? " active" : ""}`} aria-label={label} aria-pressed={query[key]} title={label} onClick={() => controller.setQuery({ [key]: !query[key] })}>{icon}</button>
  );
  return (
    <div className="diff-find-bar" role="search" aria-label="Find in diff" onKeyDown={(event) => event.stopPropagation()}>
      <input
        ref={input}
        type="text"
        spellCheck={false}
        aria-label="Find in diff"
        aria-invalid={invalid}
        placeholder="Find in diff"
        value={query.text}
        onChange={(event) => controller.setQuery({ text: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); controller.step(event.shiftKey ? -1 : 1); }
          else if (event.key === "Escape") { event.preventDefault(); controller.close(); }
        }}
      />
      <span className="diff-find-count" role="status" title={capped ? `Showing the first ${MAX_MATCHES} matches` : undefined}>{count}</span>
      {toggle("caseSensitive", "Match case", <CaseSensitive size={14} aria-hidden="true" />)}
      {toggle("wholeWord", "Whole word", <WholeWord size={14} aria-hidden="true" />)}
      {toggle("regex", "Regular expression", <Regex size={14} aria-hidden="true" />)}
      <button type="button" className="icon-button compact" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={matches.length === 0} onClick={() => controller.step(-1)}><ChevronUp size={14} aria-hidden="true" /></button>
      <button type="button" className="icon-button compact" aria-label="Next match" title="Next match (Enter)" disabled={matches.length === 0} onClick={() => controller.step(1)}><ChevronDown size={14} aria-hidden="true" /></button>
      <button type="button" className="icon-button compact" aria-label="Close find" title="Close (Esc)" onClick={controller.close}><X size={14} aria-hidden="true" /></button>
    </div>
  );
}
