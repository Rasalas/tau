import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import type { ExtensionRegistry, PaletteItem, PaletteMenu, PaletteSearchContext, WorkbenchActions } from "../extension-system";
import { menuRows, paletteRows, readOnlyCommands, readOnlySources, rowEntry, stepRow, type PaletteCommand, type PaletteRow, type PaletteSourceResult } from "../palette-results";
import { searchSettings, settingsSearchEntries } from "../settings/settings-search";
import { settingsTarget } from "../settings/settings-nav";
import { commandRefusal, useHostCapabilities } from "../use-host-capabilities";
import { ThreadStoreContext } from "../workbench-context";
import { errorMessage } from "../../workbench/error-message";
import { VirtualList } from "./VirtualList";
import { Spinner } from "./ui/Feedback";
import { tooltipProps } from "./ui/Tooltip";
import { useFocusReturn, useFocusTrap } from "./ui/focus";
import "./command-palette.css";

/** Core's own source: the Settings pages and rows, found by the words Settings search uses. */
const SETTINGS_SOURCE = { id: "core.settings", label: "Settings" };
const SETTINGS_LIMIT = 5;
const NO_RESULTS: PaletteSourceResult[] = [];
/** The breadcrumb names this many levels at most; the ones between collapse to "…". */
const CRUMBS = 3;

/** A level opened under a row; `parentQuery` is what the level below had typed, given back on the way out. */
interface PaletteLevel {
  key: number;
  menu: PaletteMenu;
  parentQuery: string;
}

type LevelAnswer = { key: number; items: readonly PaletteItem[]; loading: boolean; error?: string };

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
    pages: registry.getSettingsPages().map((page) => ({ id: page.id, label: page.label, description: page.description, keywords: page.keywords, extensionName: page.extensionName, rows: page.rows })),
    extensions: registry.getExtensionSummaries(),
  });
  return searchSettings(entries, needle, SETTINGS_LIMIT).map((entry) => ({
    id: entry.id,
    label: entry.label,
    detail: entry.section,
    access: "read",
    run: (actions) => actions.openSettings(settingsTarget(entry.page, entry.target)),
  }));
}

export function CommandPalette({
  open,
  commands,
  extensionCount,
  actions,
  registry,
  shortcutFor,
  menu,
  onClose,
}: {
  open: boolean;
  /** The id of a command with a `submenu`: the palette opens on its level. */
  menu?: string;
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
  const [levels, setLevels] = useState<readonly PaletteLevel[]>([]);
  const [reply, setReply] = useState<LevelAnswer>();
  const levelKey = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLElement>(null);
  const threads = useContext(ThreadStoreContext);
  const { readOnly } = useHostCapabilities();
  // The workbench hands a new actions object on some renders; that is no reason to search again.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  // Closing gives focus back to where it was, else to the composer.
  useFocusReturn(open, surface, () => actionsRef.current.focusComposer?.());
  useFocusTrap(surface, open);

  const typed = query.trim();
  const needle = typed.toLowerCase();
  const level = levels.at(-1);

  const searchContext = (signal: AbortSignal): PaletteSearchContext => {
    const snapshot = threads?.getSnapshot();
    return {
      actions: actionsRef.current,
      index: { projects: snapshot?.projects ?? [], threads: snapshot?.threads ?? [], ...(snapshot?.activeThreadId ? { activeThreadId: snapshot.activeThreadId } : {}) },
      signal,
    };
  };
  const contextRef = useRef(searchContext);
  contextRef.current = searchContext;

  // Every source is asked again for every query; an answer that arrives after
  // the next keystroke is dropped, and the source sees its signal abort.
  useEffect(() => {
    if (!open || !needle || !registry || level) return;
    const controller = new AbortController();
    const context = contextRef.current(controller.signal);
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
  }, [level, needle, open, registry]);

  // A level is asked when it opens and on every keystroke, under the same rules as a source.
  useEffect(() => {
    if (!open || !level) return;
    const controller = new AbortController();
    const settle = (next: Omit<LevelAnswer, "key">) => {
      if (!controller.signal.aborted) setReply({ key: level.key, ...next });
    };
    let items: ReturnType<PaletteMenu["items"]>;
    try {
      // A level gets the query as typed: a path or a URL keeps its case.
      items = level.menu.items(typed, contextRef.current(controller.signal));
    } catch (error) {
      settle({ items: [], loading: false, error: errorMessage(error) });
      return () => controller.abort();
    }
    if (Array.isArray(items)) settle({ items, loading: false });
    else {
      // The rows on screen stay until the new ones come, so typing does not flicker.
      setReply((held) => ({ key: level.key, items: held?.key === level.key ? held.items : [], loading: true }));
      void Promise.resolve(items).then(
        (resolved) => settle({ items: resolved, loading: false }),
        (error: unknown) => settle({ items: [], loading: false, error: errorMessage(error) }),
      );
    }
    return () => controller.abort();
  }, [level, typed, open]);

  const results = found.needle === needle ? found.results : NO_RESULTS;
  const levelAnswer = level && reply?.key === level.key ? reply : undefined;
  const rows = useMemo(
    () => level
      ? menuRows(levelAnswer?.items ?? [], needle, level.menu.searches)
      : readOnly
        ? paletteRows(readOnlyCommands(commands), needle, readOnlySources(results))
        : paletteRows(commands, needle, results),
    [commands, level, levelAnswer, needle, readOnly, results],
  );
  const refusal = (row: PaletteRow | undefined) => (row ? commandRefusal(rowEntry(row), readOnly) : undefined);
  const usable = (index: number) => Boolean(rows[index]) && !refusal(rows[index]);
  // The cursor never rests on a row this device may not run.
  const next = usable(cursor) ? cursor : stepRow(rows.length, cursor - 1, 1, usable);
  const current = usable(next) ? next : -1;

  useEffect(() => {
    if (!open) return;
    const start = menu ? commands.find((command) => command.id === menu && !commandRefusal(command, readOnly))?.submenu : undefined;
    setQuery("");
    setCursor(0);
    setFound({ needle: "", results: [] });
    setReply(undefined);
    setLevels(start ? [{ key: ++levelKey.current, menu: start, parentQuery: "" }] : []);
    requestAnimationFrame(() => input.current?.focus());
    // The commands may change while the palette is open; that is no reason to start over.
  }, [open, menu]);

  useEffect(() => setCursor(0), [needle, level]);

  if (!open) return null;

  const enter = (submenu: PaletteMenu) => {
    setLevels((held) => [...held, { key: ++levelKey.current, menu: submenu, parentQuery: query }]);
    setQuery("");
    input.current?.focus();
  };
  /** Back to the level with `depth` levels above the commands; 0 is the commands. */
  const back = (depth = levels.length - 1) => {
    const left = levels[depth];
    if (!left) return;
    setLevels(levels.slice(0, depth));
    setQuery(left.parentQuery);
    input.current?.focus();
  };

  const run = (row: PaletteRow) => {
    if (refusal(row)) return;
    const submenu = row.kind === "command" ? row.command.submenu : row.item.submenu;
    if (submenu) { enter(submenu); return; }
    const done = row.kind === "command" ? row.command.run(actions) : row.item.run?.(actions);
    void Promise.resolve(done).catch((error: unknown) => actions.notify(errorMessage(error)));
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (current >= 0) setCursor(stepRow(rows.length, current, event.key === "ArrowDown" ? 1 : -1, usable));
    }
    if (event.key === "Enter" && rows[current]) {
      // Cancelling the keydown drops its keypress, which would submit a dialog the command opens.
      event.preventDefault();
      run(rows[current]);
    }
    if (event.key === "Backspace" && level && query === "") {
      event.preventDefault();
      back();
    }
  };

  const shown = levels.length > CRUMBS ? levels.slice(-(CRUMBS - 1)) : levels;
  const hiddenCrumbs = levels.length - shown.length;
  // Before a level's first answer the list stays blank for the frame it takes, rather than flashing "Loading".
  const emptyLine = level && !levelAnswer ? <p className="palette-empty" />
    : levelAnswer?.error ? <p className="palette-empty" role="alert">{levelAnswer.error}</p>
      : levelAnswer?.loading ? <p className="palette-empty palette-loading"><Spinner size="xs" label="Loading" /> Loading…</p>
        : <p className="palette-empty">{level && !needle ? level.menu.empty ?? "Nothing here." : `Nothing matches “${query}”.`}</p>;
  const trailing = (row: PaletteRow): ReactNode => {
    const item = row.kind === "item" ? row.item : undefined;
    const submenu = row.kind === "command" ? row.command.submenu : item?.submenu;
    const shortcut = row.kind === "command" ? shortcutFor?.(row.command.id) : undefined;
    return <>
      {refusal(row) ? <small className="palette-locked">{readOnly ? "Read only" : "Unavailable"}</small> : null}
      {item?.current ? <small className="palette-current">Current</small> : null}
      {shortcut ? <kbd className="keyboard-hint">{shortcut}</kbd> : null}
      {submenu ? <ChevronRight className="palette-chevron" size={14} aria-hidden /> : null}
    </>;
  };

  // A tap on a row it may not run shows why, as on any disabled control.
  const lockProps = (row: PaletteRow, index: number) => {
    const reason = refusal(row);
    return reason
      ? { "aria-disabled": true as const, ...tooltipProps(reason, { side: "left" }) }
      : { onMouseMove: () => setCursor(index) };
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
        {level ? <nav className="palette-crumbs" aria-label="Palette levels">
          <button type="button" onClick={() => back(0)}>Commands</button>
          {hiddenCrumbs > 0 ? <><ChevronRight size={11} aria-hidden /><button type="button" aria-label="Back one level" onClick={() => back(hiddenCrumbs - 1)}>…</button></> : null}
          {shown.map((entry, index) => {
            const depth = hiddenCrumbs + index;
            const last = depth === levels.length - 1;
            return <span key={entry.key} className="palette-crumb">
              <ChevronRight size={11} aria-hidden />
              {last ? <strong aria-current="page">{entry.menu.title}</strong> : <button type="button" onClick={() => back(depth + 1)}>{entry.menu.title}</button>}
            </span>;
          })}
        </nav> : null}
        <div className="palette-input-wrap">
          {level
            ? <button type="button" className="palette-back" aria-label="Back" onClick={() => back()}><ArrowLeft size={15} /></button>
            : <span>›</span>}
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={level ? level.menu.placeholder ?? "Search…" : registry ? "Run a command, find a thread, a project or a setting…" : "Run a command…"}
            aria-label={level ? level.menu.title : "Command"}
          />
          {levelAnswer?.loading && levelAnswer.items.length > 0 ? <Spinner size="xs" label="Loading" /> : null}
          <kbd className="keyboard-hint">esc</kbd>
        </div>
        <VirtualList
          items={rows}
          itemHeight={38}
          className="palette-results"
          scrollToIndex={Math.max(current, 0)}
          empty={emptyLine}
          renderItem={(row, index) => row.kind === "command" ? <button
            key={row.key}
            className={index === current ? "selected" : ""}
            data-group={row.command.group}
            {...lockProps(row, index)}
            onClick={() => run(row)}
          >
            <span>{highlight(row.command.label, needle)}</span><small>{row.command.extensionName.toLowerCase()}</small>{trailing(row)}
          </button> : <button
            key={row.key}
            className={index === current ? "selected" : ""}
            data-source={row.source || undefined}
            {...lockProps(row, index)}
            onClick={() => run(row)}
          >
            {row.item.icon ? <i className="palette-icon">{row.item.icon}</i> : null}
            <span>{highlight(row.item.label, needle)}{row.item.detail ? <em>{row.item.detail}</em> : null}</span>{row.source ? <small>{row.source.toLowerCase()}</small> : null}{trailing(row)}
          </button>}
        />
        <footer>
          <span className="keyboard-hint">↑↓ navigate</span>
          <span className="keyboard-hint">↵ {level ? "select" : "run"}</span>
          {level ? <span className="keyboard-hint">⌫ back</span> : null}
          <span className="spacer" />
          {level ? <span className="keyboard-hint">esc close</span> : <span>{extensionCount} extensions contribute {commands.length} commands</span>}
        </footer>
      </section>
    </div>
  );
}
