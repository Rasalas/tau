import { useId, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { RegionProps } from "tau";
import { subscriptionLoginWarning, warnsAbout } from "./policy.js";

/** Keeps the warning visible at the thread title while such a model is the thread's, without turning it into another label. */
export function SubscriptionLoginIndicator({ snapshot }: RegionProps) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const model = snapshot?.model;
  if (!warnsAbout(model)) return null;
  const warning = subscriptionLoginWarning(model.provider);
  return (
    <span
      className="subscription-login-indicator"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="Subscription login warning"
        aria-describedby={open ? tooltipId : undefined}
      >
        <ShieldAlert size={21} strokeWidth={1.8} />
      </button>
      {open ? (
        <span className="subscription-login-popover" id={tooltipId} role="tooltip">
          <strong>{warning.title}</strong>
          <span>{warning.message}</span>
        </span>
      ) : null}
    </span>
  );
}
