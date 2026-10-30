import { useEffect, useState } from "react";
import type { UiFileContent } from "tau";
import type { FilesHost } from "./protocol.js";
import type { PassiveContent, PassivePreview, PreviewBlock } from "./passive-preview.js";

function Blocks({ blocks }: { blocks: PreviewBlock[] }) {
  // Text nodes only: generated HTML/Markdown cannot re-enable authored links,
  // directives, formulas, images or embedded objects.
  return <>{blocks.map((block, index) => block.kind === "table"
    ? <div className="files-table-scroll" key={index}><table className="files-table"><tbody>{block.rows?.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table></div>
    : block.kind === "heading" ? <h2 key={index}>{block.text}</h2>
      : block.kind === "list" ? <ul key={index}><li>{block.text}</li></ul> : <p key={index}>{block.text}</p>)}</>;
}

function Archive({ content }: { content: Extract<PassiveContent, { kind: "archive" }> }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const folders = new Set<string>();
  for (const entry of content.entries) {
    const parts = entry.name.split("/").slice(0, 64); parts.pop();
    for (let index = 0; index < parts.length && folders.size < 10_000; index++) folders.add(parts.slice(0, index + 1).join("/") + "/");
  }
  return <>
    <p className="files-notice">{content.entries.filter((entry) => !entry.directory).length.toLocaleString("en-US")} files · {(content.unpackedBytes / 1024 / 1024).toFixed(1)} MB unpacked</p>
    <table className="files-table" aria-label="Archive entries"><thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead><tbody>
      {[...[...folders].map((name) => ({ name, folder: true as const })), ...content.entries.filter((entry) => !entry.directory).map((entry) => ({ name: entry.name, folder: false as const, entry }))]
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        .filter((item) => ![...closed].some((folder) => item.name !== folder && item.name.startsWith(folder)))
        .map((item, index) => <tr key={index}><td style={{ paddingLeft: `${Math.min(64, item.name.split("/").filter(Boolean).length - 1) * 12 + 8}px` }}>{item.folder
          ? <button type="button" className="text-button" aria-expanded={!closed.has(item.name)} onClick={() => setClosed((value) => { const next = new Set(value); if (next.has(item.name)) next.delete(item.name); else next.add(item.name); return next; })}>{item.name}</button>
          : <>{item.entry.encrypted ? <span role="img" aria-label="Encrypted">🔒 </span> : null}{item.name}{item.entry.link ? ` → ${item.entry.link}` : ""}</>}</td><td>{item.folder ? "" : `${item.entry.size.toLocaleString("en-US")} B`}</td><td>{item.folder ? "" : item.entry.modified ?? ""}</td></tr>)}
    </tbody></table>
  </>;
}

function Content({ content, onTable }: { content: PassiveContent; onTable(name: string): void }) {
  const [sheet, setSheet] = useState(0);
  const [chapter, setChapter] = useState(0);
  const [schema, setSchema] = useState(false);
  if (content.kind === "document") return <Blocks blocks={content.blocks} />;
  if (content.kind === "archive") return <Archive content={content} />;
  if (content.kind === "sheet") {
    const selected = content.sheets[sheet] ?? content.sheets[0];
    return <>
      <div className="files-preview-segments" role="group" aria-label="Sheets">{content.sheets.map((item, index) => <button className="text-button" type="button" key={index} aria-pressed={sheet === index} onClick={() => setSheet(index)}>{item.name}</button>)}</div>
      <label className="files-preview-compact">Sheet <select value={sheet} onChange={(event) => setSheet(Number(event.target.value))}>{content.sheets.map((item, index) => <option value={index} key={index}>{item.name}</option>)}</select></label>
      {selected ? <>
        <p className="files-notice">Sheet {sheet + 1} of {content.sheets.length} · {selected.rows.length.toLocaleString("en-US")} of {selected.rowCount.toLocaleString("en-US")} rows</p>
        <table className="files-table" aria-label={selected.name}><tbody>{selected.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} title={cell.formula}>{cell.value}</td>)}</tr>)}</tbody></table>
      </> : <p>No sheets to preview.</p>}
    </>;
  }
  if (content.kind === "slides") return <>{content.slides.map((slide, index) => <section key={index}><h2>Slide {index + 1}</h2><Blocks blocks={slide.blocks} />{slide.notes.length ? <details><summary>Notes</summary><Blocks blocks={slide.notes} /></details> : null}</section>)}</>;
  if (content.kind === "book") {
    const current = content.chapters[chapter];
    return <><h1>{content.title}</h1><p>{content.author}</p><nav aria-label="Table of contents">{content.chapters.map((item, index) => <button type="button" className="text-button" key={index} aria-current={index === chapter ? "page" : undefined} onClick={() => setChapter(index)}>{item.title}</button>)}</nav>
      <div className="files-preview-chapters"><button className="text-button" disabled={chapter === 0} onClick={() => setChapter((value) => value - 1)}>Previous chapter</button><button className="text-button" disabled={chapter >= content.chapters.length - 1} onClick={() => setChapter((value) => value + 1)}>Next chapter</button></div>
      {current ? <section aria-label={current.title}><h2>{current.title}</h2><Blocks blocks={current.blocks} /></section> : null}</>;
  }
  const selected = content.tables.find((table) => table.name === content.selected);
  return <div className="files-preview-database"><nav aria-label="Tables and views" className="files-preview-tables">{content.tables.map((table) => <button type="button" className="text-button" key={table.name} aria-pressed={table.name === content.selected} onClick={() => onTable(table.name)}>{table.name} · {table.type}</button>)}</nav>
    <div><label className="files-preview-compact">Table or view <select value={content.selected} onChange={(event) => onTable(event.target.value)}>{content.tables.map((table) => <option value={table.name} key={table.name}>{table.name}</option>)}</select></label>
      <p className="files-notice">{content.selected} · {content.columns.length} columns{content.approximateRows !== undefined ? ` · about ${content.approximateRows.toLocaleString("en-US")} rows` : ""}</p>
      <div role="group" aria-label="Database view"><button className="text-button" aria-pressed={!schema} onClick={() => setSchema(false)}>Rows</button><button className="text-button" aria-pressed={schema} onClick={() => setSchema(true)}>Schema</button></div>
      {schema || selected?.type === "view" ? <pre>{selected?.schema}</pre> : <table className="files-table" aria-label={`${content.selected} rows`}><thead><tr>{content.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{content.rows.map((row, index) => <tr key={index}>{row.map((value, column) => <td key={column}>{value}</td>)}</tr>)}</tbody></table>}
    </div></div>;
}

function DatabaseTextFallback({ host, workspace, path }: { host: FilesHost; workspace: string; path: string }) {
  const [content, setContent] = useState<UiFileContent>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void host.read(workspace, path).then((file) => { if (live) setContent(file); }, () => { if (live) setError("Couldn't read this file."); });
    return () => { live = false; };
  }, [host, workspace, path]);
  if (error) return <p role="alert">{error}</p>;
  if (!content) return null;
  return content.kind === "text" ? <div>{content.truncated ? <p>Only part of this file is shown.</p> : null}<pre>{content.text}</pre></div> : <p>Binary file. Open it in another app.</p>;
}

export function PassivePreviewView({ host, workspace, path, onUnsupported }: { host: FilesHost; workspace: string; path: string; onUnsupported?(): void }) {
  const [result, setResult] = useState<PassivePreview>();
  const [reading, setReading] = useState(false);
  const [table, setTable] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<string>();
  useEffect(() => { setResult(undefined); setTable(undefined); }, [host, workspace, path]);
  useEffect(() => {
    let cancelled = false;
    setReading(false); setFailure(undefined);
    const timer = setTimeout(() => { if (!cancelled) setReading(true); }, 300);
    host.preview(workspace, path, table).then((answer) => { if (!cancelled) { if (answer.ok) setResult(answer); else { setFailure(answer.error); setResult((old) => old?.ok ? old : answer); } } }, () => { if (!cancelled) setFailure("Couldn't read this file. Open it in another app."); });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [host, workspace, path, table, attempt]);
  const plainDatabase = !!result && !result.ok && result.reason === "unsupported" && /\.db$/iu.test(path);
  useEffect(() => { if (plainDatabase) onUnsupported?.(); }, [plainDatabase, onUnsupported]);
  if (plainDatabase) return onUnsupported ? null : <DatabaseTextFallback host={host} workspace={workspace} path={path} />;
  if (!result && !failure) return reading ? <div className="stage-empty" role="status">Reading…</div> : null;
  const retry = <button type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</button>;
  if (!result?.ok) return <div className="stage-empty" role="status">{failure ?? (result && !result.ok ? result.error : "")} {retry}</div>;
  return <div className="files-passive-preview">
    {failure ? <p role="alert">{failure} {retry}</p> : null}
    {result.notices.map((notice, index) => <p key={index} className="files-notice" role="status">{notice}</p>)}
    <Content content={result.content} onTable={setTable} />
  </div>;
}
