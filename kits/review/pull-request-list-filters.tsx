import { useId } from "react";
import { X } from "lucide-react";
import { Sheet } from "tau";
import type { PullRequestListState } from "./protocol.js";
import type { PullRequestInvolvement, PullRequestListFilters, PullRequestListPreferences, PullRequestListSort } from "./pull-request-list-logic.js";

export const STATES: Array<{ value: PullRequestListState; label: string }> = [
  { value: "open", label: "Open" },
  { value: "closed", label: "Closed" },
  { value: "merged", label: "Merged" },
  { value: "all", label: "All" },
];
export const INVOLVEMENTS: Array<{ value: PullRequestInvolvement; label: string }> = [
  { value: "all", label: "All" },
  { value: "reviewing", label: "Reviewing" },
  { value: "authored", label: "Authored" },
];
export const SORT_LABELS: Record<PullRequestListSort, string> = {
  ready: "Merge readiness",
  blocked: "Blocked on me",
  updated: "Recently updated",
  newest: "Newest shown",
  oldest: "Oldest shown",
  largest: "Largest shown",
  smallest: "Smallest shown",
};
export const REVIEW_LABELS: Record<NonNullable<PullRequestListFilters["review"]>, string> = {
  approved: "Approved",
  "changes-requested": "Changes requested",
  "review-required": "Review required",
  none: "No reviews",
};

/** One control of the filter sheet: pills to pick one, pills to pick several, or the platform's list for many options. */
export interface FilterGroup {
  id: string;
  legend: string;
  kind: "one" | "many" | "list";
  options: Array<{ id: string; label: string; hint?: string; selected: boolean }>;
}

/** A restriction in force, as a chip outside the sheet; `id` is what removing it clears. */
export interface Narrowing {
  id: string;
  label: string;
}

/** Everything that narrows the list away from its defaults (open requests, anyone's, every project), in the sheet's order. */
export function listNarrowings(input: Pick<PullRequestListPreferences, "state" | "involvement" | "draft" | "review" | "checks"> & {
  /** The project the page is kept to; absent on every project, and on a thread's tab, whose project is not a choice. */
  project?: string | undefined;
  labels: readonly string[];
  author?: string | undefined;
  host?: string | undefined;
}): Narrowing[] {
  return [
    ...(input.project ? [{ id: "project", label: input.project }] : []),
    ...(input.state !== "open" ? [{ id: "state", label: input.state === "all" ? "Any state" : STATES.find((state) => state.value === input.state)!.label }] : []),
    ...(input.involvement !== "all" ? [{ id: "involvement", label: INVOLVEMENTS.find((option) => option.value === input.involvement)!.label }] : []),
    ...(input.draft ? [{ id: "draft", label: input.draft === "only" ? "Drafts only" : "No drafts" }] : []),
    ...(input.review ? [{ id: "review", label: REVIEW_LABELS[input.review] }] : []),
    ...(input.checks ? [{ id: "checks", label: input.checks === "passing" ? "Checks passing" : "Checks failing" }] : []),
    ...input.labels.map((label) => ({ id: `label:${label}`, label })),
    ...(input.author ? [{ id: "author", label: `@${input.author}` }] : []),
    ...(input.host ? [{ id: "host", label: input.host }] : []),
  ];
}

/**
 * The list's filters, grouping, sort and project on a phone, where the
 * desktop's header rows and menus would take five lines. Every choice applies
 * at once; the sheet says how many requests it leaves.
 */
export function PullRequestFilterSheet({ groups, summary, onPick, onClear, onClose }: {
  groups: readonly FilterGroup[];
  summary?: string | undefined;
  onPick(id: string): void;
  /** Set while anything narrows the list. */
  onClear?: (() => void) | undefined;
  onClose(): void;
}) {
  return (
    <Sheet title="Filter pull requests" className="pr-filter-sheet" onClose={onClose}>
      {summary ? <p className="pr-sheet-summary" role="status">{summary}</p> : null}
      {groups.map((group) => <FilterControl key={group.id} group={group} onPick={onPick} />)}
      {onClear ? <button type="button" className="pr-sheet-clear" onClick={onClear}>Clear filters</button> : null}
    </Sheet>
  );
}

function FilterControl({ group, onPick }: { group: FilterGroup; onPick(id: string): void }) {
  const name = useId();
  if (group.kind === "list") {
    const selected = group.options.find((option) => option.selected) ?? group.options[0];
    return (
      <label className="pr-sheet-group pr-sheet-list">
        <span className="pr-sheet-legend">{group.legend}</span>
        <select value={selected?.id ?? ""} onChange={(event) => onPick(event.target.value)}>
          {group.options.map((option) => <option key={option.id} value={option.id}>{option.hint ? `${option.label} (${option.hint})` : option.label}</option>)}
        </select>
      </label>
    );
  }
  return (
    <fieldset className="pr-sheet-group">
      <legend className="pr-sheet-legend">{group.legend}</legend>
      <div className="pr-sheet-pills">
        {group.options.map((option) => (
          <label key={option.id} className="pr-sheet-pill">
            <input type={group.kind === "one" ? "radio" : "checkbox"} name={name} checked={option.selected} onChange={() => onPick(option.id)} />
            <span>{option.label}{option.hint ? <small>{option.hint}</small> : null}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The restrictions in force under the one-line header, each removable, and all at once. */
export function NarrowingChips({ items, onRemove, onClear }: { items: readonly Narrowing[]; onRemove(id: string): void; onClear(): void }) {
  if (items.length === 0) return null;
  return (
    <div className="pr-list-chips" role="group" aria-label="Active filters">
      {items.map((item) => (
        <button key={item.id} type="button" className="pr-list-chip" aria-label={`Remove filter: ${item.label}`} onClick={() => onRemove(item.id)}>
          <span>{item.label}</span><X size={14} aria-hidden="true" />
        </button>
      ))}
      {items.length > 1 ? <button type="button" className="pr-list-chip clear" onClick={onClear}>Clear all</button> : null}
    </div>
  );
}
