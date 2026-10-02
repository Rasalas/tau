import { useSyncExternalStore } from "react";
import { ArrowUp, ChevronLeft, TriangleAlert, X } from "lucide-react";
import { tooltipProps } from "tau";
import type { DetailFile, ReviewDetailStore } from "./review-detail-store.js";
import { plural } from "./review-words.js";

function FileRow({ file, active, jump }: { file: DetailFile; active: boolean; jump(path: string): void }) {
  return (
    <li>
      <button type="button" className={active ? "active" : undefined} aria-current={active ? "true" : undefined} {...tooltipProps(file.path, { side: "right" })} onClick={() => jump(file.path)}>
        {file.conflict ? <TriangleAlert size={12} className="rvd-warn" aria-hidden="true" /> : null}
        <span className="rvd-side-path">{file.path.split("/").slice(-2).join("/")}</span>
        <span className="rvd-side-count">
          {file.hunks ? plural(file.hunks, "hunk") : null}
          {file.added && !file.hunks ? <span className="stat-add">+{file.added}</span> : null}
          {file.removed && !file.hunks ? <span className="stat-del">−{file.removed}</span> : null}
        </span>
      </button>
    </li>
  );
}

/**
 * The page's sidebar while a review is open (design 1e): the way back above
 * and below, the review's files, its turns or commits, and the notes
 * collected on its lines, kept until they are sent.
 */
export function ReviewDetailSidebar({ store, detailKey, back, backLabel }: { store: ReviewDetailStore; detailKey: string; back(): void; backLabel: string }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const actions = store.actions();
  const own = state?.key === detailKey ? state : undefined;
  const conflicting = own?.files.filter((file) => file.conflict) ?? [];
  const clean = own?.files.filter((file) => !file.conflict) ?? [];
  const backButton = (
    <button type="button" className="rvd-back" onClick={back}><ChevronLeft size={14} aria-hidden="true" /><span>{backLabel}</span></button>
  );
  return (
    <div className="rvd-side">
      {backButton}
      <div className="rvd-side-scroll">
        {own && actions ? (
          <>
            {conflicting.length > 0 ? (
              <>
                <h2 className="rvd-side-heading">Conflicts · {conflicting.length} of {plural(own.files.length, "file")}</h2>
                <ul className="rvd-side-files" aria-label="Conflicting files">{conflicting.map((file) => <FileRow key={file.path} file={file} active={own.active === file.path} jump={actions.jump} />)}</ul>
                {clean.length > 0 ? <h2 className="rvd-side-heading">Clean · {clean.length}</h2> : null}
                <ul className="rvd-side-files" aria-label="Clean files">{clean.map((file) => <FileRow key={file.path} file={file} active={own.active === file.path} jump={actions.jump} />)}</ul>
              </>
            ) : (
              <>
                <h2 className="rvd-side-heading">Files · {own.files.length + own.moreFiles}</h2>
                <ul className="rvd-side-files" aria-label="Files">
                  {own.files.map((file) => <FileRow key={file.path} file={file} active={own.active === file.path} jump={actions.jump} />)}
                  {own.moreFiles > 0 ? <li className="rvd-side-more">and {plural(own.moreFiles, "more file")}</li> : null}
                </ul>
              </>
            )}
            {own.turns.length > 0 ? (
              <>
                <h2 className="rvd-side-heading">{own.turnsHeading} · {own.turns.length}</h2>
                <ol className="rvd-side-turns" aria-label={own.turnsHeading}>
                  {own.turns.map((title, index) => <li key={index}><span>{index + 1}</span><span title={title}>{title}</span></li>)}
                </ol>
              </>
            ) : null}
            <h2 className="rvd-side-heading">Review notes · {own.notes.length}<span>kept until you send</span></h2>
            {own.notes.length > 0 ? (
              <ul className="rvd-side-notes" aria-label="Review notes">
                {own.notes.map((note) => (
                  <li key={note.id}>
                    <span className="rvd-side-note-head">
                      <span title={note.label}>{note.label}</span>
                      {actions.sendNote ? <button type="button" aria-label={`Send the note on ${note.label}`} onClick={() => actions.sendNote?.(note.id)}><ArrowUp size={10} aria-hidden="true" /> Send</button> : null}
                      <button type="button" className="icon" aria-label={`Remove the note on ${note.label}`} onClick={() => actions.removeNote(note.id)}><X size={11} aria-hidden="true" /></button>
                    </span>
                    <span className="rvd-side-note-text">{note.text}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="rvd-side-empty">Add a note from the button beside a line.</p>}
            {own.notes.length > 0 ? (
              <button type="button" className="rvd-send" disabled={Boolean(own.sendDisabled)} {...(own.sendDisabled ? tooltipProps(own.sendDisabled, { side: "right" }) : {})} onClick={() => actions.sendAll()}>
                <ArrowUp size={11} aria-hidden="true" /> {own.sendLabel}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {backButton}
    </div>
  );
}
