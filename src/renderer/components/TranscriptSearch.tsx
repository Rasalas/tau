import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { UiMessage } from "../../shared/contracts";

export interface TranscriptSearchProps {
  messages: readonly UiMessage[];
  onJump(messageId: string): void;
  onClose(): void;
}

export function TranscriptSearch({ messages, onJump, onClose }: TranscriptSearchProps) {
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: string[] = [];
    for (const msg of messages) {
      if (msg.text && msg.text.toLowerCase().includes(q)) {
        results.push(msg.id);
      } else if (msg.thinking && msg.thinking.toLowerCase().includes(q)) {
        results.push(msg.id);
      }
    }
    return results;
  }, [messages, query]);

  useEffect(() => {
    setMatchIndex(0);
    if (matches.length > 0 && matches[0]) {
      onJump(matches[0]);
    }
  }, [matches, onJump]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const goToMatch = (index: number) => {
    if (matches.length === 0) return;
    const next = (index + matches.length) % matches.length;
    setMatchIndex(next);
    const id = matches[next];
    if (id) onJump(id);
  };

  return (
    <div className="transcript-search-bar" role="search" aria-label="Search transcript">
      <Search size={14} color="var(--muted)" />
      <input
        ref={inputRef}
        type="text"
        placeholder="Find in transcript…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            goToMatch(e.shiftKey ? matchIndex - 1 : matchIndex + 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <span className="search-count">
        {query.trim() ? (matches.length > 0 ? `${matchIndex + 1} of ${matches.length}` : "0 matches") : ""}
      </span>
      <button
        type="button"
        title="Previous match (⇧Enter)"
        aria-label="Previous match"
        disabled={matches.length === 0}
        onClick={() => goToMatch(matchIndex - 1)}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={matches.length === 0}
        onClick={() => goToMatch(matchIndex + 1)}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        title="Close search (Esc)"
        aria-label="Close search"
        onClick={onClose}
      >
        <X size={14} />
      </button>
    </div>
  );
}
