import { Code2, Eye, Save, Table2, WrapText } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { errorMessage, getClientStorage, Markdown, READ_ONLY_REASON, tooltipProps, useCommandAllowed, type StageTabHandle, type UiSharedFile, type WorkbenchActions } from "tau";
import { CodeEditor } from "./code-editor.js";
import { parseDelimited } from "./delimited.js";
import type { FileDocument } from "./document.js";
import { fileViewKind, RENDERED_BY_DEFAULT, renderedMode, renderedToggleLabel, tableDelimiter, type RenderedMode } from "./file-kind.js";
import { kit, WRAP_OPTION, wrapLines, type WorkspaceStoreLike } from "./kit.js";
import { OpenInPicker } from "./open-in.js";
import { FILES_KIT_ID, type FileEditorParams } from "./protocol.js";

/** How often the tab on screen asks whether the disk moved on. */
export const CHECK_INTERVAL_MS = 2_000;
const RENDERED_KEY = "tau.files.rendered.v1";
const PDF_FRAGMENT = "#toolbar=0&view=FitH";

const isMac = () => typeof navigator !== "undefined" && /mac|iphone|ipad/iu.test(navigator.platform);

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function fileEditorParams(params: Record<string, unknown>): FileEditorParams {
  const line = typeof params.line === "number" && Number.isSafeInteger(params.line) && params.line > 0 ? params.line : undefined;
  return { path: typeof params.path === "string" ? params.path : "", ...(line ? { line } : {}) };
}

export function fileName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

/** Rendered or source is a preference per kind of document, kept on this client like T3 Code keeps it. */
function readStoredRendered(): Partial<Record<RenderedMode, boolean>> {
  try {
    return JSON.parse(getClientStorage()?.get(RENDERED_KEY) ?? "{}") as Partial<Record<RenderedMode, boolean>>;
  } catch {
    return {};
  }
}

function readRendered(mode: RenderedMode): boolean {
  const stored = readStoredRendered()[mode];
  return typeof stored === "boolean" ? stored : RENDERED_BY_DEFAULT[mode];
}

/** A client without storage keeps the choice for this tab only. */
function writeRendered(mode: RenderedMode, rendered: boolean): void {
  getClientStorage()?.set(RENDERED_KEY, JSON.stringify({ ...readStoredRendered(), [mode]: rendered }));
}

const noPreferences = () => () => undefined;

/** The wrap switch, shared by every editor tab and Settings. */
function useWrapLines(): boolean {
  const preferences = kit.current?.preferences;
  return useSyncExternalStore(preferences?.subscribe ?? noPreferences, () => preferences ? wrapLines(preferences) : false);
}

function useWorkspaceStore(): WorkspaceStoreLike | undefined {
  const subscribe = useCallback((listener: () => void) => {
    const listeners = kit.current?.listeners;
    listeners?.add(listener);
    return () => { listeners?.delete(listener); };
  }, []);
  return useSyncExternalStore(subscribe, () => kit.current?.workspace);
}

/** Where the path's folders read quietly and the name stands out, as T3 Code's breadcrumbs do. */
function Breadcrumbs({ path }: { path: string }) {
  const parts = path.split("/").filter(Boolean);
  const name = parts.pop() ?? path;
  return <span className="files-crumbs" title={path}>
    {parts.map((part, index) => <span key={index} className="files-crumb">{part}<span className="files-crumb-sep">/</span></span>)}
    <strong>{name}</strong>
  </span>;
}

/** A PDF, an image, audio or video, loaded by URL from the window's own process. */
function SharedMedia({ path, kind, actions }: {
  path: string;
  kind: "pdf" | "image" | "audio" | "video";
  actions: WorkbenchActions;
}) {
  const [shared, setShared] = useState<UiSharedFile>();
  const [error, setError] = useState<string>();
  const root = useWorkspaceStore()?.getSnapshot().cwd;
  const absolute = root ? `${root.replace(/\/$/u, "")}/${path}` : undefined;

  useEffect(() => {
    let cancelled = false;
    setShared(undefined);
    setError(undefined);
    if (!absolute || !actions.shareFile) {
      setError("This window cannot load the file by itself. Open it in an editor instead.");
      return;
    }
    actions.shareFile(absolute).then(
      (answer) => {
        if (cancelled) return;
        if (answer) setShared(answer);
        else setError("This window cannot load the file by itself. Open it in an editor instead.");
      },
      (reason: unknown) => { if (!cancelled) setError(errorMessage(reason)); },
    );
    return () => { cancelled = true; };
  }, [absolute, actions]);

  if (error) return <div className="stage-empty" role="status">{error}</div>;
  if (!shared) return <div className="stage-empty" role="status">Loading…</div>;
  const name = fileName(path);
  if (kind === "pdf") return <iframe className="files-frame files-pdf" src={`${shared.url}${PDF_FRAGMENT}`} title={name} />;
  if (kind === "image") return <div className="files-media"><img src={shared.url} alt={name} /></div>;
  if (kind === "audio") return <div className="files-media"><audio controls preload="metadata" src={shared.url} aria-label={name} /></div>;
  return <div className="files-media"><video controls preload="metadata" src={shared.url} aria-label={name} /></div>;
}

function DelimitedTable({ text, name, delimiter }: { text: string; name: string; delimiter: "," | "\t" }) {
  const table = parseDelimited(text, delimiter);
  const [header, ...body] = table.rows;
  return <div className="files-table-wrap">
    {table.truncated ? <p className="files-notice" role="status">Table limited to the first 100 rows and 30 columns. Switch to source for the rest.</p> : null}
    <div className="files-table-scroll">
      <table className="files-table" aria-label={name}>
        {header ? <thead><tr>{header.map((cell, index) => <th key={index} scope="col">{cell}</th>)}</tr></thead> : null}
        <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
  </div>;
}

/**
 * A PDF, an image, audio or video on the stage. Its bytes never pass through
 * the page: the window's own process serves the file by URL.
 */
export function MediaTab({ params, handle, actions }: { params: FileEditorParams; handle: StageTabHandle; actions: WorkbenchActions }) {
  const workspace = useWorkspaceStore();
  const kind = fileViewKind(params.path);
  const name = fileName(params.path);
  useEffect(() => { handle.setTitle(name); }, [handle, name]);
  return <div className="files-tab">
    <header className="stage-pane-header files-header">
      <Breadcrumbs path={params.path} />
      <span className="spacer" />
      {workspace ? <OpenInPicker store={workspace} relPath={params.path} /> : null}
    </header>
    <div className="files-body">{kind === "text" ? null : <SharedMedia path={params.path} kind={kind} actions={actions} />}</div>
  </div>;
}

function RenderedIcon({ mode, rendered }: { mode: RenderedMode; rendered: boolean }) {
  if (rendered) return <Code2 size={14} />;
  return mode === "table" ? <Table2 size={14} /> : <Eye size={14} />;
}

function statusText(state: ReturnType<FileDocument["getState"]>): string | undefined {
  if (state.saving) return "Saving…";
  if (state.dirty) return "Unsaved";
  return undefined;
}

/** Saves one document the way the tab's button does, saying why when it cannot. */
export async function saveDocument(document: FileDocument, name: string, actions: Pick<WorkbenchActions, "notify">): Promise<void> {
  const current = document.getState();
  if (current.conflict) { actions.notify(`${name} changed on disk. Reload it or keep your version first.`); return; }
  if (!current.editable) return;
  const saved = await document.save();
  if (saved) void kit.current?.workspace?.refresh();
  else if (document.getState().saveError) actions.notify(`Could not save ${name}: ${document.getState().saveError}`);
}

/**
 * One workspace text file on the stage: an editor with save, and a rendered
 * view beside the source for Markdown, HTML and tables. The buffer is the
 * kit's, so it outlives this component while the tab is in the background.
 */
export function FileEditorTab({ params, handle, actions, document }: {
  params: FileEditorParams;
  handle: StageTabHandle;
  actions: WorkbenchActions;
  document: FileDocument;
}) {
  const state = useSyncExternalStore(document.subscribe, document.getState);
  const workspace = useWorkspaceStore();
  const mode = renderedMode(params.path);
  const [rendered, setRendered] = useState(() => mode ? readRendered(mode) : false);
  const caretLine = useRef<number | undefined>(params.line);
  const name = fileName(params.path);
  const root = useRef<HTMLDivElement>(null);
  // A banner button that goes away must not take the keyboard with it: ⌘S belongs to this tab.
  const refocus = () => requestAnimationFrame(() => (root.current?.querySelector<HTMLElement>(".cm-content") ?? root.current)?.focus());
  const wrap = useWrapLines();
  // A Read-only device opens the file to read: no edit it could not save.
  const mayWrite = useCommandAllowed(FILES_KIT_ID, "write");

  useEffect(() => { handle.setTitle(name); }, [handle, name]);

  // The tab on screen notices a change on disk: at once, every few seconds, and when the window comes back.
  useEffect(() => {
    void document.check();
    const tick = () => { if (globalThis.document?.visibilityState !== "hidden") void document.check(); };
    const timer = setInterval(tick, CHECK_INTERVAL_MS);
    window.addEventListener("focus", tick);
    return () => { clearInterval(timer); window.removeEventListener("focus", tick); };
  }, [document]);

  const save = useCallback(() => saveDocument(document, name, actions), [actions, document, name]);

  const toggleRendered = () => {
    if (!mode) return;
    const next = !rendered;
    setRendered(next);
    writeRendered(mode, next);
  };

  const content = state.content;
  // A reload keeps the editor, and with it the scroll position and the undo history.
  const reloading = state.status === "loading" && content?.kind === "text";
  const showsText = (state.status === "ready" || reloading) && content?.kind === "text";
  const meta = content ? formatBytes(content.size) : undefined;
  const status = statusText(state);
  const showsSource = showsText && !(mode && rendered);
  const wrapLabel = wrap ? "Disable word wrap" : "Enable word wrap";

  let body: ReactNode;
  if (state.status === "loading" && !reloading) {
    body = <div className="stage-empty" role="status">Loading…</div>;
  } else if (state.status === "error") {
    body = <div className="stage-empty" role="alert">{state.error}</div>;
  } else if (content?.kind === "image") {
    body = <div className="files-media"><img src={content.dataUrl} alt={name} /></div>;
  } else if (content?.kind === "binary") {
    body = <div className="stage-empty" role="status">Binary file ({formatBytes(content.size)}) — nothing to show here.</div>;
  } else if (mode && rendered) {
    body = mode === "markdown"
      ? <div className="files-markdown"><Markdown>{state.text}</Markdown></div>
      : mode === "html"
        // No scripts, no same origin: a page can draw and nothing else.
        ? <iframe className="files-frame" sandbox="" srcDoc={state.text} title={name} />
        : <DelimitedTable text={state.text} name={name} delimiter={tableDelimiter(params.path)} />;
  } else {
    body = <CodeEditor
      text={state.text}
      path={params.path}
      label={`Contents of ${params.path}`}
      readOnly={!state.editable || !mayWrite || reloading}
      wrap={wrap}
      {...(params.line ? { line: params.line } : {})}
      onChange={(text) => document.edit(text)}
      onCaretLine={(line) => { caretLine.current = line; }}
    />;
  }

  // `editorFocus` holds anywhere in the tab, so `files.save` (`mod+s`) wins over the stash binding here.
  return <div ref={root} tabIndex={-1} className="files-tab" data-keybinding-context="editor" data-dirty={state.dirty || undefined}>
    <header className="stage-pane-header files-header">
      <Breadcrumbs path={params.path} />
      {meta ? <small>{meta}</small> : null}
      {status ? <small className="files-status" role="status">{status}</small> : null}
      <span className="spacer" />
      {mode && showsText ? <button
        type="button"
        className="icon-button files-action"
        aria-label={renderedToggleLabel(mode, rendered)}
        aria-pressed={rendered}
        title={renderedToggleLabel(mode, rendered)}
        onClick={toggleRendered}
      ><RenderedIcon mode={mode} rendered={rendered} /></button> : null}
      {showsSource ? <button
        type="button"
        className="icon-button files-action"
        aria-label={wrapLabel}
        aria-pressed={wrap}
        title={wrapLabel}
        onClick={() => kit.current?.preferences.setOption(FILES_KIT_ID, WRAP_OPTION, !wrap)}
      ><WrapText size={14} /></button> : null}
      {state.editable ? <button
        type="button"
        className="text-button files-save"
        disabled={!mayWrite || !state.dirty || state.saving || Boolean(state.conflict)}
        {...tooltipProps(!mayWrite ? READ_ONLY_REASON : isMac() ? "Save (⌘S)" : "Save (Ctrl+S)")}
        onClick={() => void save()}
      ><Save size={12} /> Save</button> : null}
      {workspace ? <OpenInPicker store={workspace} relPath={params.path} line={() => caretLine.current} /> : null}
    </header>
    {state.conflict ? <div className="files-conflict" role="alert">
      <span>{state.conflict.deleted ? `${name} was deleted on disk.` : `${name} changed on disk${state.dirty ? " while you were editing it" : ""}.`}</span>
      <span className="spacer" />
      {state.conflict.deleted
        ? <button type="button" className="text-button" onClick={() => actions.closeStageTab(handle.id)}>Close</button>
        : <button type="button" className="text-button" onClick={() => { void document.reload().then(refocus); }}>Reload from disk</button>}
      <button type="button" className="text-button" onClick={() => { document.keepMine(); refocus(); }}>Keep my version</button>
    </div> : null}
    {showsText && content?.truncated ? <p className="files-notice" role="status">
      Showing the first {formatBytes(state.text.length)} of a {formatBytes(content.size)} file. Open it in an editor to change it.
    </p> : null}
    {state.saveError ? <p className="files-notice files-error" role="alert">Could not save: {state.saveError}</p> : null}
    <div className="files-body">{body}</div>
  </div>;
}
