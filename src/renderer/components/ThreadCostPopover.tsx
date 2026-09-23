import { useRef } from "react";
import { useKeepClear } from "../reserved-region";
import type { UiThreadUsage } from "../../shared/contracts";
import { threadUsageSections } from "../cost-sections";

/** What the thread spent and, apart from it, what a subscription covered; loaded when first opened. */
export default function ThreadCostPopover({ usage }: { usage: UiThreadUsage }) {
  const popover = useRef<HTMLDivElement>(null);
  // It hangs past the composer's right edge, which is where the dock begins.
  useKeepClear(popover, true);
  const sections = threadUsageSections(usage);
  return (
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
  );
}
