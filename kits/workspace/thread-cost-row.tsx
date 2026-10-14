import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Coins } from "lucide-react";
import { Popover, usePreferences, useThreadStore, useWorkbenchShell, type RegionProps } from "tau";
import { costLabel, ThreadCostDetails } from "./thread-cost-popover.js";
import { threadCostSummary } from "./thread-cost.js";

/** Current usage of the thread and its linked descendants, derived from the existing stores. */
export function ThreadCostRow({ snapshot }: RegionProps) {
  const preferences = usePreferences();
  const showCosts = useSyncExternalStore(preferences.subscribe, () => preferences.getSnapshot().showCosts);
  const store = useThreadStore();
  const { registry } = useWorkbenchShell();
  const threads = useSyncExternalStore(store.subscribe, store.getSnapshot).threads;
  const subscribe = useCallback((listener: () => void) => registry.subscribeData("lineage", listener), [registry]);
  const lineage = useSyncExternalStore(subscribe, () => registry.getThreadLineage());
  const id = snapshot?.threadId ?? snapshot?.sessionId ?? "";
  const summary = useMemo(() => threadCostSummary(id, snapshot?.usage, snapshot?.model?.provider, threads, lineage.parents), [id, snapshot?.usage, snapshot?.model?.provider, threads, lineage.parents]);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<"hover" | "pinned">();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancelClose = () => { clearTimeout(timer.current); };
  const closeLater = () => {
    cancelClose();
    timer.current = setTimeout(() => setOpen((value) => value === "hover" ? undefined : value), 160);
  };
  useEffect(() => { setOpen(undefined); }, [id, showCosts]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const label = costLabel(summary.usage);
  if (!showCosts || !label) return null;
  return <>
    <button ref={anchor} type="button" className="workspace-card-row workspace-card-cost" aria-label={`Thread cost ${label}`} aria-haspopup="dialog" aria-expanded={!!open}
      onMouseEnter={() => { cancelClose(); setOpen((value) => value ?? "hover"); }} onMouseLeave={closeLater}
      onClick={() => { cancelClose(); setOpen((value) => value === "pinned" ? undefined : "pinned"); }}>
      <Coins aria-hidden /><span className="workspace-card-label">Cost</span>
      <span className={`workspace-card-accessory workspace-card-cost-value${summary.usage.subscription ? " plan" : ""}`}>{label}</span>
    </button>
    {open ? <Popover key={open} anchor={anchor} side="left" align="start" label="Thread usage" className="thread-cost-popover" takeFocus={open === "pinned"} onClose={() => { cancelClose(); setOpen(undefined); }}>
      <div onMouseEnter={cancelClose} onMouseLeave={closeLater}><ThreadCostDetails summary={summary} /></div>
    </Popover> : null}
  </>;
}
