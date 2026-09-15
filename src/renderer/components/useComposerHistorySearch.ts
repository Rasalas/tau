import { useState, useCallback, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { PromptHistory } from "../../workbench/prompt-history";

export interface UseComposerHistorySearchOptions {
  promptHistory: PromptHistory;
  text: string;
  updateDraft: (next: string) => void;
  setCaret: (pos: number) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export interface UseComposerHistorySearchResult {
  isSearching: boolean;
  searchQuery: string;
  matchedPrompt?: string;
  startSearch: () => void;
  cancelSearch: () => void;
  acceptSearch: () => void;
  handleSearchKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/**
 * Provides interactive reverse-i-search (Ctrl+R) over past submitted prompts,
 * identical in feel to GNU Readline and shell environments.
 */
export function useComposerHistorySearch(
  options: UseComposerHistorySearchOptions,
): UseComposerHistorySearchResult {
  const { promptHistory, text, updateDraft, setCaret, textareaRef } = options;

  const [isSearching, setIsSearching] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(-1);

  const searchQueryRef = useRef("");
  const matchIndexRef = useRef(-1);
  const originalDraftRef = useRef("");

  const entries = promptHistory.getEntries();

  const findMatch = useCallback(
    (query: string, fromIndex?: number): { index: number; prompt: string } | undefined => {
      if (!query) return undefined;
      const lowerQuery = query.toLowerCase();
      const startIndex = fromIndex !== undefined ? fromIndex : entries.length - 1;

      for (let i = startIndex; i >= 0; i -= 1) {
        const item = entries[i];
        if (item && item.toLowerCase().includes(lowerQuery)) {
          return { index: i, prompt: item };
        }
      }
      return undefined;
    },
    [entries],
  );

  const startSearch = useCallback(() => {
    originalDraftRef.current = text;
    searchQueryRef.current = "";
    matchIndexRef.current = -1;
    setIsSearching(true);
    setSearchQuery("");
    setMatchIndex(-1);
  }, [text]);

  const cancelSearch = useCallback(() => {
    updateDraft(originalDraftRef.current);
    setCaret(originalDraftRef.current.length);
    searchQueryRef.current = "";
    matchIndexRef.current = -1;
    setIsSearching(false);
    setSearchQuery("");
    setMatchIndex(-1);
    setTimeout(() => {
      textareaRef.current?.setSelectionRange(
        originalDraftRef.current.length,
        originalDraftRef.current.length,
      );
    }, 0);
  }, [updateDraft, setCaret, textareaRef]);

  const acceptSearch = useCallback(() => {
    searchQueryRef.current = "";
    matchIndexRef.current = -1;
    setIsSearching(false);
    setSearchQuery("");
    setMatchIndex(-1);
  }, []);

  const handleSearchKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      // Trigger search if Ctrl+R is pressed while NOT currently searching
      if (!isSearching) {
        if (
          event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.shiftKey &&
          event.key.toLowerCase() === "r"
        ) {
          event.preventDefault();
          startSearch();
          return true;
        }
        return false;
      }

      // If we are actively searching:
      // 1. Escape: Cancel and restore draft
      if (event.key === "Escape") {
        event.preventDefault();
        cancelSearch();
        return true;
      }

      // 2. Enter: Accept match
      if (event.key === "Enter") {
        event.preventDefault();
        acceptSearch();
        return true;
      }

      // 3. Ctrl+R: Cycle backwards to next match
      if (
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "r"
      ) {
        event.preventDefault();
        const currentQuery = searchQueryRef.current;
        if (currentQuery) {
          const nextMatch = findMatch(currentQuery, matchIndexRef.current - 1);
          if (nextMatch) {
            matchIndexRef.current = nextMatch.index;
            setMatchIndex(nextMatch.index);
            updateDraft(nextMatch.prompt);
            setCaret(nextMatch.prompt.length);
          } else {
            // Wrap around to the newest match
            const wrapMatch = findMatch(currentQuery, entries.length - 1);
            if (wrapMatch) {
              matchIndexRef.current = wrapMatch.index;
              setMatchIndex(wrapMatch.index);
              updateDraft(wrapMatch.prompt);
              setCaret(wrapMatch.prompt.length);
            }
          }
        }
        return true;
      }

      // 4. Backspace: Edit search query
      if (event.key === "Backspace") {
        event.preventDefault();
        const nextQuery = searchQueryRef.current.slice(0, -1);
        searchQueryRef.current = nextQuery;
        setSearchQuery(nextQuery);
        if (nextQuery) {
          const match = findMatch(nextQuery);
          if (match) {
            matchIndexRef.current = match.index;
            setMatchIndex(match.index);
            updateDraft(match.prompt);
            setCaret(match.prompt.length);
          } else {
            matchIndexRef.current = -1;
            setMatchIndex(-1);
          }
        } else {
          matchIndexRef.current = -1;
          setMatchIndex(-1);
          updateDraft(originalDraftRef.current);
          setCaret(originalDraftRef.current.length);
        }
        return true;
      }

      // 5. Printable characters: add to search query
      if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        const nextQuery = searchQueryRef.current + event.key;
        searchQueryRef.current = nextQuery;
        setSearchQuery(nextQuery);
        const match = findMatch(nextQuery);
        if (match) {
          matchIndexRef.current = match.index;
          setMatchIndex(match.index);
          updateDraft(match.prompt);
          setCaret(match.prompt.length);
        } else {
          matchIndexRef.current = -1;
          setMatchIndex(-1);
        }
        return true;
      }

      // 6. Navigation keys (Arrow keys, Tab): accept and let event pass through
      if (
        event.key.startsWith("Arrow") ||
        event.key === "Tab"
      ) {
        acceptSearch();
        return false;
      }

      return true;
    },
    [
      isSearching,
      startSearch,
      cancelSearch,
      acceptSearch,
      findMatch,
      entries,
      updateDraft,
      setCaret,
    ],
  );

  const matchedPrompt = matchIndex >= 0 ? entries[matchIndex] : undefined;

  return {
    isSearching,
    searchQuery,
    matchedPrompt,
    startSearch,
    cancelSearch,
    acceptSearch,
    handleSearchKeyDown,
  };
}
