import { Suspense, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import type { ComposerPlannerContribution, WorkbenchActions } from "../extension-system";
import { useClientStorage } from "../client-storage-context";
import { Dialog } from "./ui/Dialog";
import { WhenPicker } from "./ui/WhenPicker";
import { planPresets, rememberWhenPick, shortWhen, type WhenPick } from "./when-pick";
import "./plan-sheet.css";

const REMEMBER = "composer.plan";

/**
 * Plan message: when the draft goes into this thread, from the same list of
 * times Snooze shows, remembering the last pick. Kits add tabs beside "Once"
 * (`registerComposerPlanner`), such as a repeating schedule. Opened for a
 * message that already waits, it changes only the time.
 */
export function PlanSheet({ draft, snapshot, planners = [], actions, title = "Plan message", confirmLabel = "Plan", onPlan, onPlanned, onClose }: {
  draft: { text: string; attachments: number };
  snapshot?: HostSnapshot | undefined;
  planners?: readonly ComposerPlannerContribution[];
  actions?: WorkbenchActions | undefined;
  title?: string;
  confirmLabel?: string;
  /** Once, into this thread, at `at`. */
  onPlan(at: number): void;
  /** A planner's tab saved it. */
  onPlanned?(summary: string): void;
  onClose(): void;
}) {
  const storage = useClientStorage();
  const presets = useMemo(() => planPresets(new Date()), []);
  const [tab, setTab] = useState("once");
  const picked = useRef<{ at: number | undefined; pick: WhenPick }>({ at: undefined, pick: "" });
  const [at, setAt] = useState<number>();
  const quote = draft.text.trim().split("\n").find((line) => line.trim()) ?? (draft.attachments > 0 ? `${draft.attachments} attachment${draft.attachments === 1 ? "" : "s"}` : "");
  const shown = snapshot ? planners : [];
  const planner = shown.find((entry) => entry.id === tab);
  const plan = () => {
    const chosen = picked.current;
    if (chosen.at === undefined || chosen.at <= Date.now()) return;
    rememberWhenPick(storage, REMEMBER, chosen.pick);
    onPlan(chosen.at);
  };
  return (
    <Dialog className="confirm-dialog plan-sheet" label={title} onClose={onClose}>
      <header className="plan-sheet-head">
        <div>
          <h2>{title}</h2>
          {quote ? <p className="plan-sheet-quote">{quote}</p> : null}
        </div>
        <button type="button" className="plan-sheet-close" aria-label="Close" onClick={onClose}><X size={14} /></button>
      </header>
      {shown.length > 0 ? (
        <div className="segmented plan-sheet-tabs" role="tablist" aria-label="Plan">
          {[{ id: "once", label: "Once" }, ...shown].map((entry) => (
            <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}>{entry.label}</button>
          ))}
        </div>
      ) : null}
      {planner && snapshot ? (
        <Suspense fallback={<div className="plan-sheet-body" />}>
          <planner.Component draft={draft} snapshot={snapshot} actions={actions} onPlanned={(summary) => onPlanned?.(summary)} onCancel={onClose} />
        </Suspense>
      ) : (
        <>
          <div className="plan-sheet-body">
            <WhenPicker
              presets={presets}
              rememberKey={REMEMBER}
              label="When"
              autoFocus
              onChange={(next, pick) => { picked.current = { at: next, pick }; setAt(next); }}
              onConfirm={plan}
            />
          </div>
          <footer className="plan-sheet-footer">
            <span className="plan-sheet-note">{at !== undefined ? `Into this thread · ${shortWhen(at, Date.now())}` : "Into this thread"}</span>
            <button type="button" className="text-button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" disabled={at === undefined} onClick={plan}>{confirmLabel}</button>
          </footer>
        </>
      )}
    </Dialog>
  );
}
