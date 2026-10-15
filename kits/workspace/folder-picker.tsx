import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronDown, CornerLeftUp, Folder, FolderGit2, FolderOpen, House, Pin } from "lucide-react";
import { errorMessage, useEscapeLayer, useHostCapabilities, type ProjectSourceProps } from "tau";
import { GIT_HOST_LABELS } from "../_git-hosts/hosts.js";
import { GIT_HOST_MARKS } from "../_git-hosts/marks.js";
import { foldersBelow, groupRepositories, homeRelative, isTypedPath, joinFolder, lastSegment, rankFolders, relativeFolder, splitTypedPath, withSeparator, type FolderMatch } from "./folder-finder.js";
import type { RepositoryHost, UiDirectoryListing, UiFolderIndex } from "./protocol.js";
import { useWorkspaceStore } from "./store-context.js";

type Row =
  | { kind: "up"; path: string }
  | { kind: "folder"; path: string; label: ReactNode; repository?: RepositoryHost; title?: string };

interface Section {
  id: string;
  heading?: ReactNode;
  rows: Row[];
  note?: ReactNode;
}

type View = "repositories" | "folders";

const MOD_LABEL = typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform) ? "⌘" : "Ctrl";
const SECTION_LIMIT = 40;

function Highlighted({ text, marks, offset = 0 }: { text: string; marks: readonly number[]; offset?: number }) {
  const marked = new Set(marks);
  const parts: ReactNode[] = [];
  let run = "";
  let runMarked = false;
  const flush = (key: number) => {
    if (run) parts.push(runMarked ? <mark key={key}>{run}</mark> : run);
    run = "";
  };
  for (let index = 0; index < text.length; index += 1) {
    const isMarked = marked.has(index + offset);
    if (isMarked !== runMarked) { flush(index); runMarked = isMarked; }
    run += text[index];
  }
  flush(text.length);
  return <>{parts}</>;
}

function HostMark({ repository }: { repository?: RepositoryHost }) {
  if (!repository || repository === "git") return null;
  const Mark = GIT_HOST_MARKS[repository];
  return <i className="folder-host-mark" title={GIT_HOST_LABELS[repository]}><Mark width={13} height={13} /></i>;
}

const matchRow = (root: string, match: FolderMatch): Row =>
  ({ kind: "folder", path: joinFolder(root, match.path), label: <Highlighted text={match.path} marks={match.marks} />, ...(match.repository ? { repository: match.repository } : {}) });

/**
 * Adds a local folder (design: T3 Code's picker with a start folder and a finder).
 * It opens at the start folder with the repositories below it; typing searches
 * every folder below the current one, and `~` or `/` switch to typing a path.
 */
export function LocalFolderSource({ actions, onBack, onDone }: ProjectSourceProps) {
  const store = useWorkspaceStore();
  const host = store.host;
  const { localFiles } = useHostCapabilities();
  const [start, setStart] = useState<string>();
  const [listing, setListing] = useState<UiDirectoryListing>();
  const [indexes, setIndexes] = useState<Record<string, UiFolderIndex | "loading" | "failed">>({});
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(-1);
  const [view, setView] = useState<View>("repositories");
  const [menu, setMenu] = useState(false);
  const [pathListing, setPathListing] = useState<UiDirectoryListing | "missing">();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const open = useCallback(async (path?: string, options: { fallBack?: boolean; asStart?: boolean } = {}) => {
    const ticket = ++request.current;
    try {
      const next = await host.listDirectories(path).catch((failure: unknown) => {
        // A start folder that is gone opens the home folder instead of an error.
        if (options.fallBack) return host.listDirectories();
        throw failure;
      });
      if (ticket !== request.current) return;
      setListing(next);
      if (options.asStart) setStart(next.path);
      setText("");
      setSelected(-1);
      setMenu(false);
      if (localFiles || document.activeElement === inputRef.current) inputRef.current?.focus();
    } catch (error) {
      if (ticket === request.current) actions.notify(errorMessage(error), "error");
    }
  }, [actions, host, localFiles]);

  useEffect(() => {
    const base = store.projectBaseDirectory();
    void open(base, { fallBack: base !== undefined, asStart: true });
  }, [open, store]);

  // The start folder's index serves every folder below it; outside it the current folder gets its own.
  const indexRoot = listing && start !== undefined && relativeFolder(start, listing.path) !== undefined ? start : listing?.path;
  const index = indexRoot ? indexes[indexRoot] : undefined;
  useEffect(() => {
    if (!indexRoot || indexes[indexRoot]) return;
    setIndexes((known) => ({ ...known, [indexRoot]: "loading" }));
    host.findFolders(indexRoot).then(
      (found) => setIndexes((known) => ({ ...known, [indexRoot]: found })),
      () => setIndexes((known) => ({ ...known, [indexRoot]: "failed" })),
    );
  }, [host, indexRoot, indexes]);

  const ready = typeof index === "object" ? index : undefined;
  const here = ready && listing ? relativeFolder(ready.root, listing.path) : undefined;
  const below = useMemo(() => ready && here !== undefined ? foldersBelow(ready, here) : [], [ready, here]);
  const repositoryCount = useMemo(() => below.filter((folder) => folder.repository).length, [below]);

  const typedPath = isTypedPath(text);
  const query = typedPath ? "" : text.trim();
  const { folder: typedFolder, leaf } = splitTypedPath(text);
  const pathRequest = useRef(0);
  useEffect(() => {
    if (!typedPath || !typedFolder) { setPathListing(undefined); return; }
    const ticket = ++pathRequest.current;
    const timer = window.setTimeout(() => {
      host.listDirectories(typedFolder).then(
        (next) => { if (ticket === pathRequest.current) setPathListing(next); },
        () => { if (ticket === pathRequest.current) setPathListing("missing"); },
      );
    }, 120);
    return () => window.clearTimeout(timer);
  }, [host, typedFolder, typedPath]);

  const showRepositories = view === "repositories" && repositoryCount > 0;
  const sections = useMemo((): Section[] => {
    if (!listing) return [];
    if (typedPath) {
      if (pathListing === "missing") return [{ id: "path", rows: [], note: `No folder at ${typedFolder}` }];
      const needle = leaf.toLocaleLowerCase();
      const rows = (pathListing?.directories ?? [])
        .filter((directory) => directory.name.toLocaleLowerCase().startsWith(needle))
        .map((directory): Row => ({ kind: "folder", path: directory.path, label: directory.name, ...(directory.repository ? { repository: directory.repository } : {}) }));
      return [{ id: "path", heading: <>Path <code>{typedFolder}</code></>, rows, ...(pathListing && rows.length === 0 ? { note: leaf ? `Enter adds ${text}` : "No folders in here" } : {}) }];
    }
    if (query) {
      if (!ready) {
        const needle = query.toLocaleLowerCase();
        const rows = listing.directories.filter((directory) => directory.name.toLocaleLowerCase().includes(needle))
          .map((directory): Row => ({ kind: "folder", path: directory.path, label: directory.name, ...(directory.repository ? { repository: directory.repository } : {}) }));
        return [{ id: "direct", heading: "Folders", rows, note: index === "failed" ? "Could not search the folders below" : "Searching the folders below…" }];
      }
      const repositories = rankFolders(below.filter((folder) => folder.repository), query, SECTION_LIMIT);
      const folders = rankFolders(below.filter((folder) => !folder.repository), query, SECTION_LIMIT);
      const found: Section[] = [];
      if (repositories.length) found.push({ id: "repositories", heading: <>Repositories <small>{repositories.length}</small></>, rows: repositories.map((match) => matchRow(listing.path, match)) });
      if (folders.length) found.push({ id: "folders", heading: <>Folders <small>{folders.length}</small></>, rows: folders.map((match) => matchRow(listing.path, match)) });
      return found.length ? found : [{ id: "none", rows: [], note: `Nothing below ${homeRelative(listing.path)} matches “${query}”` }];
    }
    if (showRepositories) {
      return groupRepositories(below).map((group) => ({
        id: `group:${group.key}`,
        heading: group.key
          ? <button type="button" className="folder-group-open" onClick={() => void open(joinFolder(listing.path, group.key))}>{group.key}</button>
          : `In ${lastSegment(listing.path)}`,
        rows: group.repositories.map((repository): Row => ({ kind: "folder", path: joinFolder(listing.path, repository.path), label: repository.name, ...(repository.repository ? { repository: repository.repository } : {}), title: repository.path })),
      }));
    }
    const rows: Row[] = [
      ...(listing.parent ? [{ kind: "up" as const, path: listing.parent }] : []),
      ...listing.directories.map((directory): Row => ({ kind: "folder", path: directory.path, label: directory.name, ...(directory.repository ? { repository: directory.repository } : {}) })),
    ];
    const note = index === "loading" && view === "repositories" ? "Finding repositories…" : listing.directories.length === 0 ? "No folders in here" : undefined;
    return [{ id: "folders", rows, ...(note ? { note } : {}) }];
  }, [below, index, leaf, listing, open, pathListing, query, ready, showRepositories, text, typedFolder, typedPath, view]);

  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const current = Math.min(selected, rows.length - 1);
  const highlighted = current >= 0 ? rows[current] : undefined;
  useEffect(() => { listRef.current?.querySelector(".selected")?.scrollIntoView?.({ block: "nearest" }); }, [current]);

  useEscapeLayer(() => setMenu(false), menu);
  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const add = async (path?: string) => {
    if (!listing || busy) return;
    setBusy(true);
    try {
      const target = path && path !== listing.path ? await host.listDirectories(path) : listing;
      if (await actions.openWorkspace(target.workspace.workspaceId)) onDone();
    } catch (error) {
      actions.notify(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const choose = async () => {
    try {
      const picked = await host.pickFolder();
      if (picked && await actions.openWorkspace(picked.workspaceId)) onDone();
    } catch (error) {
      actions.notify(errorMessage(error), "error");
    }
  };
  const setStartFolder = (path: string | undefined) => {
    store.setProjectBaseDirectory(path);
    void open(path, { asStart: true });
  };
  const chooseStart = async () => {
    setMenu(false);
    try {
      const picked = await host.pickFolder();
      if (picked) setStartFolder(picked.displayPath);
    } catch (error) {
      actions.notify(errorMessage(error), "error");
    }
  };
  const changeText = (next: string) => {
    setText(next);
    setSelected(next.trim() && !isTypedPath(next) ? 0 : -1);
  };
  const enter = (row: Row) => {
    if (typedPath && row.kind === "folder") changeText(withSeparator(homeRelative(row.path)));
    else void open(row.path);
  };
  const addTyped = () => void add(highlighted?.kind === "folder" ? highlighted.path : text.trim() || undefined);

  const startRelative = start !== undefined && listing ? relativeFolder(start, listing.path) : undefined;
  const startLabel = start === undefined ? "" : homeRelative(start) === "~" ? "~" : lastSegment(start);
  const parts = startRelative ? startRelative.split("/") : [];
  const shownParts = parts.length > 3 ? parts.slice(-2) : parts;

  return <div className="folder-browser folder-finder">
    <header className="project-modal-bar">
      <button type="button" className="project-modal-bar-glyph" onClick={onBack} aria-label="Back to project sources"><ArrowLeft size={15} /></button>
      <div className="folder-crumbs">
        <button
          type="button"
          className={`folder-start${menu ? " open" : ""}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-label="Start folder"
          title={start ? `Start folder: ${homeRelative(start)}` : "Start folder"}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => setMenu((value) => !value)}
        ><Pin size={12} aria-hidden />{startRelative !== undefined ? <span>{startLabel}</span> : null}<ChevronDown size={11} aria-hidden /></button>
        {startRelative === undefined && listing
          ? <><button type="button" className="folder-crumb folder-crumb-outside" onClick={() => void open(listing.path)}>{homeRelative(listing.path)}</button><span>/</span></>
          : <>
            {start !== undefined && parts.length > shownParts.length ? <><span>/</span><span className="folder-crumb-more" title={homeRelative(listing?.path ?? "")}>…</span></> : null}
            {shownParts.map((part, step) => {
              const depth = parts.length - shownParts.length + step + 1;
              return <span key={depth} className="folder-crumb-step"><span>/</span><button type="button" className="folder-crumb" onClick={() => void open(joinFolder(start!, parts.slice(0, depth).join("/")))}>{part}</button></span>;
            })}
            <span>/</span>
          </>}
      </div>
      <input
        ref={inputRef}
        value={text}
        spellCheck={false}
        onChange={(event) => changeText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && (event.key === "1" || event.key === "2")) {
            event.preventDefault();
            setView(event.key === "1" ? "repositories" : "folders");
            setSelected(-1);
            return;
          }
          if (event.key === "ArrowDown") { event.preventDefault(); setSelected(Math.min(current + 1, rows.length - 1)); return; }
          if (event.key === "ArrowUp") { event.preventDefault(); setSelected(Math.max(-1, current - 1)); return; }
          const atEnd = event.currentTarget.selectionStart === text.length;
          if (event.key === "Tab" || (event.key === "ArrowRight" && atEnd && highlighted)) {
            const target = highlighted ?? rows.find((row) => row.kind === "folder");
            if (target) { event.preventDefault(); enter(target); }
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (event.nativeEvent.isComposing) return;
            if (highlighted?.kind === "up") void open(highlighted.path);
            else if (typedPath) addTyped();
            else void add(highlighted?.path);
            return;
          }
          if (event.key === "Backspace" && !text && listing?.parent) { event.preventDefault(); void open(listing.parent); }
        }}
        placeholder="Find a folder… (~ or / types a path)"
        aria-label="Find a folder"
      />
      <button type="button" className="project-modal-bar-action" disabled={!listing || busy} title={highlighted?.kind === "folder" ? homeRelative(highlighted.path) : listing ? homeRelative(listing.path) : undefined} onClick={() => typedPath ? addTyped() : void add(highlighted?.kind === "folder" ? highlighted.path : undefined)}>
        Add <kbd>↵</kbd>
      </button>
    </header>
    {menu && listing ? <div className="folder-start-menu" role="menu" ref={menuRef}>
      <p>Start folder <code>{start ? homeRelative(start) : "~"}</code><br />Where this picker opens and what it searches</p>
      {start !== undefined && listing.path !== start ? <>
        <button type="button" role="menuitem" onClick={() => void open(start)}><CornerLeftUp size={14} aria-hidden /> Go to start folder</button>
        <button type="button" role="menuitem" onClick={() => setStartFolder(listing.path)}><Pin size={14} aria-hidden /> Start here <code>{homeRelative(listing.path)}</code></button>
      </> : null}
      {store.projectBaseDirectory() ? <button type="button" role="menuitem" onClick={() => setStartFolder(undefined)}><House size={14} aria-hidden /> Home folder <code>~</code></button> : null}
      {localFiles ? <button type="button" role="menuitem" onClick={() => void chooseStart()}><FolderOpen size={14} aria-hidden /> Choose start folder…</button> : null}
    </div> : null}
    {!query && !typedPath && listing ? <div className="folder-views" role="tablist" aria-label="Show">
      <button type="button" role="tab" aria-selected={showRepositories} disabled={Boolean(ready) && repositoryCount === 0} onClick={() => { setView("repositories"); setSelected(-1); }}>
        Repositories <small>{ready ? repositoryCount : "…"}</small>
      </button>
      <button type="button" role="tab" aria-selected={!showRepositories} onClick={() => { setView("folders"); setSelected(-1); }}>
        Folders <small>{listing.directories.length}</small>
      </button>
      <small className="keyboard-hint">{MOD_LABEL}1 {MOD_LABEL}2</small>
    </div> : null}
    <div className="folder-browser-results" role="listbox" aria-label="Folders" ref={listRef}>
      {sections.map((section) => {
        const offset = rows.indexOf(section.rows[0]!);
        return <div key={section.id} className="folder-section">
          {section.heading ? <div className="folder-section-heading">{section.heading}</div> : null}
          {section.rows.map((row, at) => {
            const position = offset + at;
            return <button
              type="button"
              role="option"
              aria-selected={position === current}
              className={position === current ? "selected" : ""}
              key={`${row.kind}:${row.path}`}
              title={row.kind === "folder" ? row.title : undefined}
              onClick={() => enter(row)}
              onDoubleClick={() => { if (row.kind === "folder") void add(row.path); }}
            >
              {row.kind === "up" ? <CornerLeftUp size={15} aria-hidden /> : row.repository ? <FolderGit2 size={15} className="folder-repository-icon" aria-hidden /> : <Folder size={15} aria-hidden />}
              <span>{row.kind === "up" ? ".." : row.label}</span>
              {row.kind === "folder" ? <HostMark {...(row.repository ? { repository: row.repository } : {})} /> : null}
            </button>;
          })}
          {section.note ? <p>{section.note}</p> : null}
        </div>;
      })}
      {ready?.truncated && !typedPath ? <p>Stopped after {ready.folders.length} folders; type a path to look further.</p> : null}
    </div>
    <footer className="project-modal-footer">
      {localFiles ? <button type="button" onClick={() => void choose()}><FolderOpen size={14} /> Choose a folder…</button> : null}
      <small className="keyboard-hint"><kbd>⇥</kbd> open <kbd>⌫</kbd> up <kbd>↵</kbd> add <kbd>~ /</kbd> path</small>
    </footer>
  </div>;
}
