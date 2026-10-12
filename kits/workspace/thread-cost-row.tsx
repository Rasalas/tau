import { useSyncExternalStore } from "react";
import { Coins } from "lucide-react";
import { threadCostLabel, threadUsageLines, tooltipProps, usePreferences, type RegionProps } from "tau";

/** What the thread on screen has cost, where the head's details used to say it; the split is the tooltip, which the card cannot clip. */
export function ThreadCostRow({ snapshot }: RegionProps) {
  const preferences = usePreferences();
  const showCosts = useSyncExternalStore(preferences.subscribe, () => preferences.getSnapshot().showCosts);
  const usage = snapshot?.usage;
  const label = threadCostLabel(usage);
  if (!showCosts || !usage || !label) return null;
  const plan = usage.costUsd <= 0 && usage.subscription !== undefined;
  return <div className="workspace-card-row workspace-card-cost" tabIndex={0} aria-label={`Thread cost ${label}`}
    {...tooltipProps(threadUsageLines(usage).join("\n"), { variant: "lines", side: "left" })}
  >
    <Coins aria-hidden /><span className="workspace-card-label">Cost</span>
    <span className={`workspace-card-accessory workspace-card-cost-value${plan ? " plan" : ""}`}>{label}</span>
  </div>;
}
