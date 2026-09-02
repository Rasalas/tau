import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CommandContribution, ContributionOwner, WorkbenchActions } from "../extension-system";
import { VirtualList } from "./VirtualList";

type Command = CommandContribution & ContributionOwner;

/** Underline the matched run so the reason a command ranked is visible. */
function highlight(label: string, query: string): ReactNode {
  if (!query) return label;
  const index = label.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return label;
  return (
    <>
      {label.slice(0, index)}
      <mark>{label.slice(index, index + query.length)}</mark>
      {label.slice(index + query.length)}
    </>
  );
}

function score(command: Command, query: string): number {
  if (!query) return 1;
  const label = command.label.toLowerCase();
  const index = label.indexOf(query);
  if (index === 0) return 3;
  if (index > 0) return 2;
  return `${command.group} ${command.extensionName}`.toLowerCase().includes(query) ? 1 : 0;
}

export function CommandPalette({
  open,
  commands,
  extensionCount,
  actions,
  shortcutFor,
  onClose,
}: {
  open: boolean;
  commands: Command[];
  extensionCount: number;
  actions: WorkbenchActions;
  /** The chord label bound to a command, from the registry's keybindings. */
  shortcutFor?: (commandId: string) => string | undefined;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => commands
      .map((command) => ({ command, rank: score(command, needle) }))
      .filter((entry) => entry.rank > 0)
      .sort((left, right) => right.rank - left.rank)
      .map((entry) => entry.command),
    [commands, needle],
  );

  // Group in first-appearance order so the ranking above still drives the layout.
  const groups = useMemo(() => {
    const byGroup = new Map<string, Command[]>();
    for (const command of matches) {
      const existing = byGroup.get(command.group);
      if (existing) existing.push(command);
      else byGroup.set(command.group, [command]);
    }
    return [...byGroup.entries()];
  }, [matches]);
  const ordered = useMemo(() => groups.flatMap(([, entries]) => entries), [groups]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  useEffect(() => setCursor(0), [needle]);



  if (!open) return null;

  const run = (command: Command) => {
    void command.run(actions);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { onClose(); return; }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => (ordered.length ? (value + 1) % ordered.length : 0));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => (ordered.length ? (value - 1 + ordered.length) % ordered.length : 0));
    }
    if (event.key === "Enter" && ordered[cursor]) run(ordered[cursor]);
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-input-wrap">
          <span>›</span>
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Run a command…"
            aria-label="Command"
          />
          <kbd>esc</kbd>
        </div>
        <VirtualList
          items={ordered}
          itemHeight={38}
          className="palette-results"
          scrollToIndex={cursor}
          empty={<p className="palette-empty">No commands match “{query}”.</p>}
          renderItem={(command, index) => <button
            key={command.id}
            className={index === cursor ? "selected" : ""}
            data-group={command.group}
            onMouseMove={() => setCursor(index)}
            onClick={() => run(command)}
          >
            <span>{highlight(command.label, needle)}</span><small>{command.extensionName.toLowerCase()}</small>{(() => { const shortcut = shortcutFor?.(command.id); return shortcut ? <kbd>{shortcut}</kbd> : null; })()}
          </button>}
        />
        <footer>
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span className="spacer" />
          <span>{extensionCount} extensions contribute {commands.length} commands</span>
        </footer>
      </section>
    </div>
  );
}
