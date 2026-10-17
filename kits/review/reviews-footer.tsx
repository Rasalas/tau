import { Fragment, useRef, useState, type ReactNode } from "react";
import { Popover } from "tau";
import { plural } from "./review-words.js";

/** The page's one muted line under a list: its parts with a dot between, none when empty. */
export function ReviewsFooter({ children }: { children: ReadonlyArray<ReactNode> }) {
  const parts = children.filter((part) => part !== null && part !== undefined && part !== false);
  if (parts.length === 0) return null;
  return (
    <div className="rv-footer">
      {parts.map((part, index) => <Fragment key={index}>{index ? <span className="rv-sep" aria-hidden="true" /> : null}{part}</Fragment>)}
    </div>
  );
}

/** "2 projects not read · Details": the details open a small card with each project and why. */
export function ReadFailures({ failures, name }: { failures: ReadonlyArray<{ workspace: string; message: string }>; name(workspace: string): string | undefined }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (failures.length === 0) return null;
  return (
    <span className="rv-failures">
      <span>{plural(failures.length, "project")} not read</span>
      <button ref={anchor} type="button" className="rv-foot-link" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>Details</button>
      {open ? (
        <Popover anchor={anchor} side="top" label="Projects not read" className="rv-failures-card" onClose={() => setOpen(false)}>
          <ul>
            {failures.map((failure) => (
              <li key={failure.workspace}><strong>{name(failure.workspace) ?? failure.workspace}</strong><span>{failure.message}</span></li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </span>
  );
}
