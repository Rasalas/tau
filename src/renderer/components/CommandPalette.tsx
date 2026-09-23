import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExtensionRegistry, PaletteItem, PaletteSearchContext, WorkbenchActions } from "../extension-system";
import { paletteRows, type PaletteCommand, type PaletteRow, type PaletteSourceResult } from "../palette-results";
import { searchSettings, settingsSearchEntries } from "../settings/settings-search";
import { ThreadStoreContext } from "../workbench-context";
import { errorMessage } from "../../workbench/error-message";
import { VirtualList } from "./VirtualList";
import { useFocusReturn, useFocusTrap } from "./ui/focus";
import "./command-palette.css";

/** Core's own source: the Settings pages and rows, found by the words Settings search uses. */
const SETTINGS_SOURCE = { id: "core.settings", label: "Settings" };
const SETTINGS_LIMIT = 5;
const NO_RESULTS: PaletteSourceResult[] = [];

/** Underline the matched run so the reason a row ranked is visible. */
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

function settingsItems(registry: ExtensionRegistry, needle: string): PaletteItem[] {
  const entries = settingsSearchEntries({
    pages: registry.getSettingsPages().map((page) => ({ id: page.id, label: page.label, keywords: page.keywords, extensionName: page.extensionName })),
    extensions: registry.getExtensionSummaries(),
  });
  return searchSettings(entries, needle, SETTINGS_LIMIT).map((entry) => ({
    id: entry.id,
    label: entry.label,
    detail: entry.section,
    run: (actions) => actions.openSettings(entry.page),
  }));
}

export function CommandPalette({
  open,
  commands,
  extensionCount,
  actions,
  registry,
  shortcutFor,
  onClose,
}: {
  open: boolean;
  commands: PaletteCommand[];
  extensionCount: number;
  actions: WorkbenchActions;
  /** Where the palette's sources and the Settings pages come from; without it, commands only. */
  registry?: ExtensionRegistry;
  /** The chord label bound to a command, from the registry's keybindings. */
  shortcutFor?: (commandId: string) => string | undefined;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [found, setFound] = useState<{ needle: string; results: PaletteSourceResult[] }>({ needle: "", results: [] });
  const input = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLElement>(null);
  const threads = useContext(ThreadStoreContext);
  // The workbench hands a new actions object on some renders; that is no reason to search again.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  // As in T3 Code: closing gives focus back to where it was, else to the composer.
  useFocusReturn(open, surface, () => actionsRef.current.focusComposer?.());
  useFocusTrap(surface, open);

  const needle = query.trim().toLowerCase();

  // Every source is asked again for every query; an answer that arrives after
  // the next keystroke is dropped, and the source sees its signal abort.
  useEffect(() => {
    if (!open || !needle || !registry) return;
    const controller = new AbortController();
    const snapshot = threads?.getSnapshot();
    const context: PaletteSearchContext = {
      actions: actionsRef.current,
      index: { projects: snapshot?.projects ?? [], threads: snapshot?.threads ?? [], ...(snapshot?.activeThreadId ? { activeThreadId: snapshot.activeThreadId } : {}) },
      signal: controller.signal,
    };
    const sources = registry.getPaletteSources();
    const answers = new Map<string, PaletteSourceResult>();
    const publish = () => {
      if (controller.signal.aborted) return;
      const results = sources.flatMap((source) => answers.get(source.id) ?? []);
      const settings = answers.get(SETTINGS_SOURCE.id);
      setFound({ needle, results: settings ? [...results, settings] : results });
    };
    answers.set(SETTINGS_SOURCE.id, { ...SETTINGS_SOURCE, items: settingsItems(registry, needle) });
    for (const source of sources) {
      let answer: ReturnType<typeof source.search>;
      try {
        answer = source.search(needle, context);
      } catch (error) {
        console.warn(`Palette source ${source.id} failed`, error);
        continue;
      }
      if (Array.isArray(answer)) {
        answers.set(source.id, { id: source.id, label: source.label, items: answer });
        continue;
      }
      void Promise.resolve(answer).then(
        (items) => { answers.set(source.id, { id: source.id, label: source.label, items }); publish(); },
        (error: unknown) => { if (!controller.signal.aborted) console.warn(`Palette source ${source.id} failed`, error); },
      );
    }
    publish();
    return () => controller.abort();
  }, [needle, open, registry, threads]);

  const results = found.needle === needle ? found.results : NO_RESULTS;
  const rows = useMemo(() => paletteRows(commands, needle, results), [commands, needle, results]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    setFound({ needle: "", results: [] });
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  useEffect(() => setCursor(0), [needle]);

  if (!open) return null;

  const run = (row: PaletteRow) => {
    const done = row.kind === "command" ? row.command.run(actions) : row.item.run(actions);
    void Promise.resolve(done).catch((error: unknown) => actions.notify(errorMessage(error)));
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => (rows.length ? (value + 1) % rows.length : 0));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => (rows.length ? (value - 1 + rows.length) % rows.length : 0));
    }
    if (event.key === "Enter" && rows[cursor]) {
      // Cancelling the keydown drops its keypress, which would submit a dialog the command opens.
      event.preventDefault();
      run(rows[cursor]);
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <section
        ref={surface}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
        // Here rather than on the field: Tab can take focus to a row.
        onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
      >
        <div className="palette-input-wrap">
          <span>›</span>
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={registry ? "Run a command, find a thread, a project or a setting…" : "Run a command…"}
            aria-label="Command"
          />
          <kbd>esc</kbd>
        </div>
        <VirtualList
          items={rows}
          itemHeight={38}
          className="palette-results"
          scrollToIndex={cursor}
          empty={<p className="palette-empty">Nothing matches “{query}”.</p>}
          renderItem={(row, index) => row.kind === "command" ? <button
            key={row.key}
            className={index === cursor ? "selected" : ""}
            data-group={row.command.group}
            onMouseMove={() => setCursor(index)}
            onClick={() => run(row)}
          >
            <span>{highlight(row.command.label, needle)}</span><small>{row.command.extensionName.toLowerCase()}</small>{(() => { const shortcut = shortcutFor?.(row.command.id); return shortcut ? <kbd>{shortcut}</kbd> : null; })()}
          </button> : <button
            key={row.key}
            className={index === cursor ? "selected" : ""}
            data-source={row.source}
            onMouseMove={() => setCursor(index)}
            onClick={() => run(row)}
          >
            <span>{highlight(row.item.label, needle)}{row.item.detail ? <em>{row.item.detail}</em> : null}</span><small>{row.source.toLowerCase()}</small>
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
