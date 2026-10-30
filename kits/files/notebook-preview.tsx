import { useEffect, useMemo, useState } from "react";
import { AttachmentLightbox, canonicalHighlightLanguage, FileSource, Markdown, type MarkdownComponents } from "tau";
import { parseNotebook, type NotebookCell, type NotebookOutput, type NotebookPreview as ParsedNotebook } from "./notebook.js";
import type { FilesHost } from "./protocol.js";

const CELLS_PER_PAGE = 20;
const SOURCE_LANGUAGES = new Set(["bash", "css", "diff", "go", "javascript", "json", "markdown", "python", "rust", "shell", "sql", "typescript", "xml", "yaml"]);

/** Saved Markdown must never turn a URL, inline path or image into a workbench action. */
const INERT_COMPONENTS: MarkdownComponents = {
  a: ({ children }) => <span>{children}</span>,
  img: ({ alt }) => <span className="files-notebook-image">[Image omitted{alt ? `: ${alt}` : ""}]</span>,
  video: () => null,
  code: ({ children }) => <code>{children}</code>,
  pre: ({ children }) => <pre>{children}</pre>,
};

function OutputImage({ output, cell, index }: { output: NotebookOutput; cell: number; index: number }) {
  const [url, setUrl] = useState<string>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const data = output.mime === "image/svg+xml" ? new TextEncoder().encode(output.text) : Uint8Array.from(atob(output.text), (char) => char.charCodeAt(0));
    const next = URL.createObjectURL(new Blob([data], { type: output.mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [output]);
  const alt = `Output image ${index + 1} of cell ${cell + 1}`;
  if (!url) return null;
  return <><button type="button" className="files-notebook-output-image" aria-label={`Open ${alt}`} onClick={() => setOpen(true)}><img src={url} alt={alt} /></button>
    {open ? <AttachmentLightbox images={[{ key: url, src: url, alt, label: alt }]} index={0} onClose={() => setOpen(false)} /> : null}</>;
}

function CellSource({ cell, index, language }: { cell: NotebookCell; index: number; language: string }) {
  const canonical = canonicalHighlightLanguage(language);
  const syntax = cell.kind === "code" && SOURCE_LANGUAGES.has(canonical) ? canonical : undefined;
  return <div className="files-notebook-source" aria-label={`Cell ${index + 1} source`}>
    <FileSource content={{ kind: "text", path: "", name: `Cell ${index + 1}`, size: cell.source.length, text: cell.source, ...(syntax ? { language: syntax } : {}) }} />
  </div>;
}

function NotebookCells({ notebook }: { notebook: Extract<ParsedNotebook, { ok: true }> }) {
  const [visible, setVisible] = useState(CELLS_PER_PAGE);
  return <div className="files-notebook">
    <p className="files-notice">{notebook.cellCount} {notebook.cellCount === 1 ? "cell" : "cells"} · {notebook.language}. Saved outputs only. Code is never executed. Links are inactive.</p>
    {notebook.notices.map((notice, index) => <p key={index} className="files-notice" role="status">{notice}</p>)}
    <div className="files-notebook-scroll">
      <div className="files-notebook-cells">
        {notebook.cells.slice(0, visible).map((cell, index) => <section className="files-notebook-cell" key={index} aria-label={`Cell ${index + 1}`}>
          <header className="files-notebook-cell-header">
            {index + 1} · {cell.kind === "code" ? notebook.language : cell.kind}
            {cell.kind === "code" ? <span>In [{cell.executionCount ?? " "}]</span> : null}
          </header>
          {cell.notices.map((notice, noteIndex) => <p key={noteIndex} className="files-notice" role="status">{notice}</p>)}
          {cell.kind === "markdown" && !cell.source.includes("\uE200")
            ? <div className="files-notebook-markdown"><Markdown components={INERT_COMPONENTS}>{cell.source}</Markdown></div>
            : <>
              {/* Markdown's wrapper recognizes app visualization directives before rendering. Keep them plain. */}
              {cell.kind === "markdown" ? <p className="files-notice" role="status">Markdown containing app directives is shown as plain text.</p> : null}
              <CellSource cell={cell} index={index} language={notebook.language} />
            </>}
          {cell.outputs.map((output, outputIndex) => output.kind === "notice"
            ? <p key={outputIndex} className="files-notice" role="status">{output.text}</p>
            : output.kind === "image" ? <OutputImage key={outputIndex} output={output} cell={index} index={cell.outputs.slice(0, outputIndex).filter((entry) => entry.kind === "image").length} />
            : <pre key={outputIndex} className={`files-notebook-output${output.kind === "error" ? " files-error" : ""}`} aria-label={`Cell ${index + 1} ${output.label}`}>
              {output.text}
            </pre>)}
        </section>)}
        {notebook.cellCount === 0 ? <p className="files-notebook-empty">This notebook is empty.</p> : null}
        {visible < notebook.cells.length ? <button type="button" className="text-button files-notebook-more" onClick={() => setVisible((count) => count + CELLS_PER_PAGE)}>
          Show more cells ({notebook.cells.length - visible} remaining)
        </button> : null}
      </div>
    </div>
  </div>;
}

export function NotebookPreview({ text, truncated = false }: { text: string; truncated?: boolean }) {
  const notebook = useMemo(() => parseNotebook(text, { truncated }), [text, truncated]);
  return notebook.ok
    ? <NotebookCells notebook={notebook} />
    : <div className="stage-empty" role="alert">{notebook.error}</div>;
}

/** Disk notebooks are parsed on their home machine; only saved preview data is transferred. */
export function HostedNotebookPreview({ host, workspace, path, revision }: { host: FilesHost; workspace: string; path: string; revision?: number }) {
  const [result, setResult] = useState<ParsedNotebook>();
  const [reading, setReading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setResult(undefined); setReading(false);
    const timer = setTimeout(() => { if (!cancelled) setReading(true); }, 300);
    host.notebook(workspace, path).then((answer) => { if (!cancelled) setResult(answer); }, () => { if (!cancelled) setResult({ ok: false, error: "Couldn't read this notebook. Switch to source or open it in an editor." }); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [host, workspace, path, revision, attempt]);
  if (!result) return reading ? <div className="stage-empty" role="status">Reading…</div> : null;
  return result.ok ? <NotebookCells notebook={result} /> : <div className="stage-empty" role="alert">{result.error} <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button></div>;
}
