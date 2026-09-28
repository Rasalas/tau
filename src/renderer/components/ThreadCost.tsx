import { lazy, Suspense, useState } from "react";
import type { UiThreadUsage } from "../../shared/contracts";
import { planUsage, threadCostLabel, threadCostOrigin } from "../cost-format";
import { tooltipProps } from "./ui/Tooltip";

const ThreadCostPopover = lazy(() => import("./ThreadCostPopover"));

/**
 * What the open thread has cost, in its head's details. It opens into the
 * token split the money came from; a model without pricing shows tokens only.
 * What a subscription covered stays apart: its tokens, and what the API would
 * have charged for them, never added to the money.
 */
export function ThreadCost({ usage, className }: { usage: UiThreadUsage; className?: string }) {
  const [open, setOpen] = useState(false);
  const label = threadCostLabel(usage);
  if (!label) return null;
  const onPlan = planUsage(usage) !== undefined;

  return (
    <span
      className={className ? `menu-anchor ${className}` : "menu-anchor"}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        className={onPlan && usage.costUsd <= 0 ? "thread-cost plan" : "thread-cost"}
        {...tooltipProps(threadCostOrigin(usage), { side: "bottom" })}
        aria-label={`Thread cost ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open ? <Suspense fallback={null}><ThreadCostPopover usage={usage} /></Suspense> : null}
    </span>
  );
}
