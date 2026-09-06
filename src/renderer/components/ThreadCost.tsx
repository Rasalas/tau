import { useState } from "react";
import type { UiThreadUsage } from "../../shared/contracts";
import { threadCostLabel, threadUsageDetail } from "../cost-format";

/**
 * What the open thread has cost, beside the context dial. It opens into the
 * token split the money came from; a model without pricing shows tokens only.
 */
export function ThreadCost({ usage }: { usage: UiThreadUsage }) {
  const [open, setOpen] = useState(false);
  const label = threadCostLabel(usage);
  if (!label) return null;
  const detail = threadUsageDetail(usage);

  return (
    <span
      className="menu-anchor"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        className="thread-cost"
        title={detail}
        aria-label={`Thread cost ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open ? (
        <div className="thread-cost-popover">
          <header>
            <strong>Spent</strong>
            <b>{label}</b>
          </header>
          <small>{detail}</small>
        </div>
      ) : null}
    </span>
  );
}
