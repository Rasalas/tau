import { Check, EyeOff, Lock, Minus, ShieldAlert, Trash2 } from "lucide-react";
import { tooltipProps } from "tau";
import { CREDENTIALS_GUARD_NOTE } from "./live-config.js";
import { groupPending } from "./status-model.js";
import type { PendingUploadRow } from "./view-protocol.js";

const LETTERS = { added: "A", modified: "M", deleted: "D" } as const;
const WORDS = { added: "new", modified: "changed", deleted: "deleted" } as const;

/** What the upload lets the user change; without it every row shows its default, read only. */
export interface PendingSelection {
  chosen(row: PendingUploadRow): boolean;
  toggle(row: PendingUploadRow): void;
  /** Why the boxes cannot be changed here, such as a Read-only device. */
  disabledReason?: string;

}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

function Choice({ row, selection }: { row: PendingUploadRow; selection: PendingSelection | undefined }) {
  const chosen = selection ? selection.chosen(row) : row.selected;
  const label = `${chosen ? "Chosen" : "Not chosen"} for the upload: ${row.path}`;
  if (selection) {
    const reason = row.blocked ?? selection.disabledReason;
    // The label is the touch target on a compact client; the box stays small.
    return (
      <label className="servers-choice-hit" {...(reason ? tooltipProps(reason) : {})}>
        <input
          type="checkbox"
          className="servers-choice-box"
          aria-label={label}
          checked={chosen}
          disabled={Boolean(reason)}
          onChange={() => selection.toggle(row)}
        />
      </label>
    );
  }
  const tip = chosen ? "An upload takes this by default" : row.blocked ?? (row.credentials ? "Left out by default: it holds credentials" : "Left out by default");
  return <span className={`servers-choice${chosen ? " chosen" : ""}`} role="img" aria-label={label} {...tooltipProps(tip)}>{chosen ? <Check size={11} /> : <Minus size={11} />}</span>;
}

function Row({ row, active, selection, onOpen }: { row: PendingUploadRow; active: boolean; selection: PendingSelection | undefined; onOpen(path: string): void }) {
  const { name, dir } = splitPath(row.path);
  const left = Boolean(selection) && row.change === "deleted" && !row.blocked && !selection!.chosen(row);
  return (
    <li className={`servers-file${active ? " active" : ""}${row.credentials ? " guarded" : ""}${row.blocked ? " blocked" : ""}`}>
      <Choice row={row} selection={selection} />
      <button type="button" className="servers-file-open" aria-current={active} aria-label={`${row.path}, ${row.unchecked ? "not compared" : WORDS[row.change]}`} onClick={() => onOpen(row.path)}>
        <span className={`servers-change ${row.unchecked ? "unchecked" : row.change}`} aria-hidden="true">{row.unchecked ? "?" : LETTERS[row.change]}</span>
        <span className="servers-file-name"><span {...tooltipProps(row.path, { when: "truncated", variant: "code" })}>{name}</span>{dir ? <small {...tooltipProps(row.path, { when: "truncated", variant: "code" })}>{dir}</small> : null}</span>
        {row.unchecked ? <span className="servers-file-tag unchecked">Not compared</span> : null}
        {left ? <span className="servers-file-tag">Stays on the server</span> : null}
        {row.blocked ? <span className="servers-file-guard" role="img" aria-label={row.blocked} {...tooltipProps(row.blocked)}><Lock size={13} /></span> : null}
        {row.credentials ? <span className="servers-file-guard" role="img" aria-label={CREDENTIALS_GUARD_NOTE} {...tooltipProps(`${CREDENTIALS_GUARD_NOTE}\n${row.credentials.join(", ")}`, { variant: "lines" })}><ShieldAlert size={13} /></span> : null}
      </button>

    </li>
  );
}

/**
 * Local candidates, explicit server deletions, and files excluded from uploads.
 */
export function PendingList({ rows, total, withheld, active, onOpen, selection }: {
  rows: readonly PendingUploadRow[];
  total: number;
  withheld: readonly string[];
  active?: string;
  onOpen(path: string): void;
  selection?: PendingSelection;
}) {
  const { changed, deleted } = groupPending(rows);
  return (
    <div className="servers-pending">
      {changed.length > 0 ? (
        <section aria-label="New and changed files">
          <h3 className="servers-group-head">Files <span className="servers-count">{changed.length}</span></h3>
          <ul className="servers-files">{changed.map((row) => <Row key={row.path} row={row} active={row.path === active} selection={selection} onOpen={onOpen} />)}</ul>
        </section>
      ) : null}
      {deleted.length > 0 ? (
        <section className="servers-deleted" aria-label="Deleted locally">
          <h3 className="servers-group-head"><Trash2 size={12} aria-hidden="true" />Deleted locally <span className="servers-count">{deleted.length}</span></h3>
          <p className="servers-group-note">Previously read on the server and now missing here. Select explicitly to delete on the server; a backup is kept.</p>
          <ul className="servers-files">{deleted.map((row) => <Row key={row.path} row={row} active={row.path === active} selection={selection} onOpen={onOpen} />)}</ul>
        </section>
      ) : null}
      {withheld.length > 0 ? (
        <section className="servers-withheld" aria-label="Never uploaded">
          <h3 className="servers-group-head"><EyeOff size={12} aria-hidden="true" />Never uploaded <span className="servers-count">{withheld.length}</span></h3>
          <ul className="servers-files">{withheld.map((path) => <li key={path} className="servers-file muted"><span className="servers-file-name" {...tooltipProps(path, { when: "truncated", variant: "code" })}>{path}</span></li>)}</ul>
        </section>
      ) : null}
      {total > rows.length ? <p className="servers-group-note">Showing {rows.length} of {total} files.</p> : null}
    </div>
  );
}
