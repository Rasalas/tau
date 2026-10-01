import { useEffect, type ReactNode, type RefObject } from "react";

export interface FrameTab<Id extends string = string> {
  id: Id;
  label: string;
  /** Beside the label: a count or a summary, "4" or "· 58 passed". */
  aside?: ReactNode;
}

/** ⌘[ (Ctrl+[ elsewhere) goes back, unless a field has the focus. Escape is the page's own. */
export function useBackKeys(back: () => void): void {
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "[" || !(event.metaKey || event.ctrlKey) || event.altKey || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      event.preventDefault();
      back();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [back]);
}

/** Unified or Split, at the right of the tabs. */
export function LayoutToggle({ layout, onChange }: { layout: "unified" | "split"; onChange(layout: "unified" | "split"): void }) {
  return (
    <div className="rvd-layout" role="group" aria-label="Diff layout">
      {(["unified", "split"] as const).map((entry) => (
        <button key={entry} type="button" className={layout === entry ? "active" : undefined} aria-pressed={layout === entry} onClick={() => onChange(entry)}>{entry === "unified" ? "Unified" : "Split"}</button>
      ))}
    </div>
  );
}

/**
 * The one review view of design 1e, for a local review and a pull request:
 * the title with its facts and actions, what the work was about, then tabs
 * over a body that scrolls. What each kind knows goes into the slots.
 */
export function ReviewDetailFrame<Id extends string>({ title, label, meta, actions, summary, notices, tabs, tab, onTab, toolbar, scrollRef, children }: {
  title: ReactNode;
  /** The article's accessible name. */
  label: string;
  meta: ReactNode;
  actions: ReactNode;
  summary?: ReactNode;
  notices?: ReactNode;
  tabs: readonly FrameTab<Id>[];
  tab: Id;
  onTab(tab: Id): void;
  toolbar?: ReactNode;
  scrollRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  return (
    <article className="rvd" aria-label={label}>
      <header className="rvd-head">
        <div className="rvd-titles">
          <h1 className="rvd-title">{title}</h1>
          <div className="rvd-meta">{meta}</div>
        </div>
        <div className="rvd-actions">{actions}</div>
      </header>
      {summary ? <div className="rvd-summary">{summary}</div> : null}
      {notices}
      {tabs.length ? (
        <div className="rvd-tabs">
          <div role="tablist" aria-label="Review sections">
            {tabs.map((entry) => (
              <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? "active" : undefined} onClick={() => onTab(entry.id)}>
                {entry.label}{entry.aside ? <span className="rvd-tab-aside">{entry.aside}</span> : null}
              </button>
            ))}
          </div>
          {toolbar ? <div className="rvd-toolbar">{toolbar}</div> : null}
        </div>
      ) : null}
      <div className="rvd-body" ref={scrollRef}>{children}</div>
    </article>
  );
}
