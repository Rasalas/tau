import { useRef, useState } from "react";
import { useKeepClear } from "../reserved-region";
import type { UiThreadUsage } from "../../shared/contracts";
import { threadCostLabel, threadUsageDetail, threadUsageSections } from "../cost-format";
import { tooltipProps } from "./ui/Tooltip";

/**
 * What the open thread has cost, beside the context dial. It opens into the
 * token split the money came from; a model without pricing shows tokens only.
 * What a subscription covered stays apart: its tokens, and what the API would
 * have charged for them, never added to the money.
 */
export function ThreadCost({ usage }: { usage: UiThreadUsage }) {
  const [open, setOpen] = useState(false);
  const popover = useRef<HTMLDivElement>(null);
  // It hangs past the composer's right edge, which is where the dock begins.
  useKeepClear(popover, open);
  const label = threadCostLabel(usage);
  if (!label) return null;
  const sections = threadUsageSections(usage);
  const tooltip = sections.plan ? label : threadUsageDetail(usage);

  return (
    <span
      className="menu-anchor"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        className={sections.plan && !sections.billed?.cost ? "thread-cost plan" : "thread-cost"}
        {...tooltipProps(tooltip)}
        aria-label={`Thread cost ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open ? (
        <div className="thread-cost-popover" ref={popover}>
          {sections.billed ? (
            <>
              <header>
                <strong>Spent</strong>
                <b>{sections.billed.cost ?? "no price"}</b>
              </header>
              <small>{sections.billed.detail}</small>
            </>
          ) : null}
          {sections.plan ? (
            <>
              <header>
                <strong>Subscription</strong>
                <b>included</b>
              </header>
              <small>{sections.plan.detail}</small>
              <small className="thread-cost-value">
                {sections.plan.value ? `Would have cost ≈ ${sections.plan.value} via the API` : "No API price known for these tokens"}
              </small>
            </>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
