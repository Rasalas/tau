import { ProviderIconStack, tooltipProps } from "tau";
import type { UsageLimitAccount, UsageLimitWindow, UsageLimitsSummary } from "./protocol.js";
import { elapsedShare, resetsIn } from "./view-model.js";

/** From here a window reads as nearly spent. */
const WARN_PERCENT = 75;
const CRITICAL_PERCENT = 90;

function resetAt(window: UsageLimitWindow, now: number): string | undefined {
  if (!window.resetsAt) return undefined;
  const at = new Date(window.resetsAt);
  const sameDay = new Date(now).toDateString() === at.toDateString();
  return at.toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * One window: how much of it is used, and when it resets. The tick on the
 * track is how far the window's time has run, where even use would be now.
 */
function WindowLine({ window, now }: { window: UsageLimitWindow; now: number }) {
  const used = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
  const elapsed = elapsedShare(window, now);
  const pace = elapsed === undefined ? undefined : Math.round(elapsed * 100);
  const countdown = resetsIn(window, now);
  const at = resetAt(window, now);
  const level = used >= CRITICAL_PERCENT ? "critical" : used >= WARN_PERCENT ? "warn" : undefined;
  const hint = [
    `${window.label}: ${used}% used`,
    pace === undefined ? undefined : `${pace}% of the window has passed; the tick is where even use would be.`,
    at ? `Resets ${at}.` : undefined,
  ].filter(Boolean).join("\n");
  return (
    <div className="usage-window" data-level={level}>
      <span className="usage-window-label">{window.label}</span>
      <div
        className="usage-meter"
        role="meter"
        aria-label={`${window.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-valuetext={`${used}% used${countdown ? `, ${countdown}` : ""}`}
        tabIndex={0}
        {...tooltipProps(hint)}
      >
        {used > 0 ? <span className="usage-meter-fill" style={{ width: `${used}%` }} /> : null}
        {pace !== undefined ? <span className="usage-meter-pace" style={{ left: `${pace}%` }} /> : null}
      </div>
      <span className="usage-window-used">{used}% used</span>
      <span className="usage-window-reset">{countdown ?? "no reset time"}{at && countdown !== "reset" ? <small>{at}</small> : null}</span>
    </div>
  );
}

function checked(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "checked just now";
  if (minutes < 60) return `checked ${minutes} min ago`;
  return `checked ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** A Pi account is one provider's login: its mark is the provider's, through Pi. */
function accountMarks(account: UsageLimitAccount): { modelProvider?: string; runtimeProvider: string } {
  const provider = account.runtime === "pi" && account.id.startsWith("pi:") ? account.id.slice(3) : undefined;
  return { ...(provider ? { modelProvider: provider } : {}), runtimeProvider: account.runtime };
}

function AccountLimits({ account, now }: { account: UsageLimitAccount; now: number }) {
  return (
    <section className="usage-account" aria-label={`${account.label} limits`}>
      <header>
        <ProviderIconStack {...accountMarks(account)} hint={{ side: "top" }} />
        <strong>{account.label}</strong>
        {account.plan ? <span className="usage-plan">{account.plan}</span> : null}
        <small>{checked(account.checkedAt, now)}</small>
      </header>
      {account.windows.map((window) => <WindowLine key={window.id} window={window} now={now} />)}
    </section>
  );
}

/**
 * How close each plan is to its limits and when they reset, the fullest
 * window first; accounts without windows say why in one line.
 */
export function UsageLimits({ limits, error, now }: { limits: UsageLimitsSummary | undefined; error: string | undefined; now: number }) {
  if (error) return <p className="usage-note" data-level="error">{error}</p>;
  if (!limits) return <p className="usage-note">Reading limits…</p>;
  const fullest = (account: UsageLimitAccount) => Math.max(0, ...account.windows.map((window) => window.usedPercent));
  const reporting = limits.accounts.filter((account) => account.windows.length > 0).sort((left, right) => fullest(right) - fullest(left));
  const silent = limits.accounts.filter((account) => account.windows.length === 0);
  return (
    <div className="usage-limits" aria-label="Limits">
      {reporting.length === 0 ? (
        <p className="usage-note">
          No plan reports its limits yet. Codex and the Agent SDK runtime report them for a signed-in plan; Pi&apos;s providers send
          them with their answers, so they show up here after a thread on a plan has answered.
        </p>
      ) : reporting.map((account) => <AccountLimits key={account.id} account={account} now={now} />)}
      {silent.length > 0 ? (
        <ul className="usage-silent" aria-label="Accounts without limits">
          {silent.map((account) => (
            <li key={account.id}>
              <ProviderIconStack {...accountMarks(account)} hint={{ side: "top" }} />
              <span {...tooltipProps(account.unavailable?.message ?? "No limits reported.", { side: "top" })}><strong>{account.label}</strong> {account.unavailable?.message ?? "No limits reported."}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
