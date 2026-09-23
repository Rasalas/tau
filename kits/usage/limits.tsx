import { formatCost, tooltipProps } from "tau";
import type { UsageLimitAccount, UsageLimitWindow, UsageLimitsSummary, UsageRow } from "./protocol.js";
import { elapsedShare, formatTokens, planUsageOf, remainingPercent, resetsIn } from "./view-model.js";

/**
 * One window as a bar from the moment it opened to its reset. The fill is the
 * quota left; the hairline is how much of the window's time is left, which is
 * where even spending would have put the fill.
 */
function WindowRow({ window, now }: { window: UsageLimitWindow; now: number }) {
  const left = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  const timeLeft = elapsed === undefined ? undefined : Math.round((1 - elapsed) * 100);
  const countdown = resetsIn(window, now);
  const at = window.resetsAt ? new Date(window.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : undefined;
  const summary = `${window.label}: ${left}% left${timeLeft === undefined ? "" : `, ${timeLeft}% of the window left`}${countdown ? `, ${countdown}` : ""}`;
  const title = [`${left}% left${timeLeft === undefined ? "" : ` · ${timeLeft}% of the window left`}`, timeLeft === undefined ? undefined : "The line is where even spending would be.", at ? `Resets ${at}` : undefined].filter(Boolean).join("\n");
  return (
    <>
      <span className="usage-window-label">
        <span>{window.label}</span>
        <b>{left}% left</b>
      </span>
      <div className="usage-window-bar" role="img" aria-label={summary} tabIndex={0} {...tooltipProps(title)} data-low={left <= 10 ? "true" : undefined}>
        <span className="usage-window-track" />
        {left > 0 ? <span className="usage-window-fill" style={{ width: `${left}%` }} /> : null}
        {timeLeft !== undefined ? <span className="usage-window-time" style={{ left: `${timeLeft}%` }} /> : null}
      </div>
      <span className="usage-window-reset">{countdown ?? ""}</span>
    </>
  );
}

function checked(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000);
  if (minutes < 1) return "checked just now";
  if (minutes < 60) return `checked ${minutes} min ago`;
  return `checked ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

/** An account's windows and, beside them, what its plan covered in the period and what that would have cost over the API. */
function AccountCard({ account, rows, periodLabel, now }: { account: UsageLimitAccount; rows: readonly UsageRow[] | undefined; periodLabel: string; now: number }) {
  const plan = rows ? planUsageOf(rows, account) : undefined;
  const value = plan ? formatCost(plan.apiValueUsd) : undefined;
  return (
    <section className="usage-account" aria-label={`${account.label} limits`}>
      <header>
        <strong>{account.label}</strong>
        {account.plan ? <span className="usage-plan">{account.plan}</span> : null}
        <small>{checked(account.checkedAt, now)}</small>
      </header>
      <div className="usage-windows">
        {account.windows.map((window) => <WindowRow key={window.id} window={window} now={now} />)}
      </div>
      {plan && plan.tokens > 0 ? (
        <p className="usage-account-value">
          {periodLabel} on the plan: {formatTokens(plan.tokens)} tokens in {plan.requests} {plan.requests === 1 ? "turn" : "turns"}
          {" · "}{value ? <>would have cost <b>≈ {value}</b> via the API</> : "no API price known for these tokens"}
        </p>
      ) : null}
    </section>
  );
}

/** Subscription limits, one card per account that reports windows; accounts without windows say why in one line. */
export function UsageLimits({ limits, error, rows, periodLabel, now }: {
  limits: UsageLimitsSummary | undefined;
  error: string | undefined;
  rows: readonly UsageRow[] | undefined;
  periodLabel: string;
  now: number;
}) {
  if (error) return <div className="settings-note" data-level="error">{error}</div>;
  if (!limits) return <div className="settings-note">Reading limits…</div>;
  const reporting = limits.accounts.filter((account) => account.windows.length > 0);
  const silent = limits.accounts.filter((account) => account.windows.length === 0);
  return (
    <div className="usage-limits" aria-label="Limits">
      {reporting.length === 0 ? (
        <div className="settings-note usage-empty">
          No subscription reports its limits yet. Codex and the Agent SDK runtime report them for a signed-in plan; Pi's providers send
          them with their answers, so they show up here after a thread on a plan has answered.
        </div>
      ) : reporting.map((account) => <AccountCard key={account.id} account={account} rows={rows} periodLabel={periodLabel} now={now} />)}
      {silent.length > 0 ? (
        <ul className="usage-silent" aria-label="Accounts without limits">
          {silent.map((account) => (
            <li key={account.id}><strong>{account.label}</strong> <span>{account.unavailable?.message ?? "No limits reported."}</span></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
