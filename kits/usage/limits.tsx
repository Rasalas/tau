import { ProviderIconStack, formatCost, tooltipProps } from "tau";
import type { UsageLimitAccount, UsageLimitSample, UsageLimitWindow, UsageLimitsSummary, UsageRow } from "./protocol.js";
import { elapsedShare, formatTokens, planUsageOf, usedPercent, resetsIn } from "./view-model.js";
import { FRESH_MS, providerOf, providerTone, quotaState } from "./quota.js";

function WindowRow({ account, window, history, now }: { account: UsageLimitAccount; window: UsageLimitWindow; history: readonly UsageLimitSample[]; now: number }) {
  const used = usedPercent(window);
  const elapsed = elapsedShare(window, now);
  const timeElapsed = elapsed === undefined ? undefined : Math.round(elapsed * 100);
  const state = quotaState(account, window, history, now);
  const expired = state.kind === "expired";
  const countdown = expired ? "Reset reached" : resetsIn(window, now) ?? "Reset time unavailable";
  const at = window.resetsAt ? new Date(window.resetsAt).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : undefined;
  const summary = expired ? `${window.label}: reset reached, waiting for a new reading` : `${window.label}: ${used}% used${timeElapsed === undefined ? "" : `, ${timeElapsed}% of the window elapsed`}, ${countdown}${state.kind === "stale" ? ", last known reading" : ""}`;
  const warning = ["exhausted", "forecast", "ahead"].includes(state.kind);
  return (
    <div className="usage-window" data-state={state.kind}>
      <div className="usage-window-label"><strong>{window.label}</strong><small>{expired ? "No current reading" : `${used}% used`}</small></div>
      <div className="usage-window-bar" role="img" aria-label={summary} tabIndex={0} {...tooltipProps(expired ? state.detail : summary)} data-low={!expired && used >= 90 ? "true" : undefined}>
        <span className="usage-window-track" />
        {!expired && used > 0 ? <span className="usage-window-fill" style={{ width: `${used}%` }} /> : null}
        {!expired && timeElapsed !== undefined ? <span className="usage-window-time" style={{ left: `${timeElapsed}%` }} /> : null}
      </div>
      <div className="usage-window-footer">
        <span className="usage-window-reset" {...tooltipProps(at ? `Resets ${at}` : countdown)}>{countdown}</span>
        <span className="usage-window-status" tabIndex={0} {...tooltipProps(state.detail)}>{warning ? <span aria-hidden="true">△ </span> : null}{state.label}</span>
      </div>
    </div>
  );
}

export function checked(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  return `Last read ${new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

function AccountCard({ account, history, rows, periodLabel, now }: { account: UsageLimitAccount; history: readonly UsageLimitSample[]; rows: readonly UsageRow[] | undefined; periodLabel: string; now: number }) {
  const plan = rows ? planUsageOf(rows, account) : undefined;
  const value = plan ? formatCost(plan.apiValueUsd) : undefined;
  const stale = !!account.unavailable || now - account.checkedAt > FRESH_MS || account.checkedAt > now;
  const provider = providerOf(account);
  return (
    <section className="usage-account" aria-label={`${account.label} limits`} data-provider={providerTone(provider)}>
      <header>
        <div className="usage-provider-mark"><ProviderIconStack modelProvider={provider} hint={false} /></div>
        <div className="usage-account-heading"><strong>{account.label}</strong><span>{account.plan ?? "Subscription"}</span></div>
        <small data-stale={stale || undefined}>{stale ? "Last known reading" : "Live reading"}</small>
      </header>
      <div className="usage-windows">
        {account.windows.map((window) => <WindowRow key={window.id} account={account} window={window} history={history} now={now} />)}
      </div>
      {plan && plan.tokens > 0 ? (
        <p className="usage-account-value">
          {periodLabel} on the plan: {formatTokens(plan.tokens)} tokens in {plan.requests} {plan.requests === 1 ? "turn" : "turns"}
          {" · "}{value ? <>would have cost <b>≈ {value}</b> via the API</> : "no API price known for these tokens"}
        </p>
      ) : null}
      <footer className="usage-account-checked">{checked(account.checkedAt, now)}</footer>
    </section>
  );
}

export function UsageLimits({ limits, error, rows, periodLabel, now }: {
  limits: UsageLimitsSummary | undefined; error: string | undefined;
  rows: readonly UsageRow[] | undefined; periodLabel: string; now: number;
}) {
  if (!limits) return <div className="settings-note" data-level={error ? "error" : undefined}>{error ?? "Reading limits…"}</div>;
  const reporting = limits.accounts.filter((account) => account.windows.length > 0);
  const silent = limits.accounts.filter((account) => account.windows.length === 0);
  return (
    <div className="usage-limits" aria-label="Limits">
      {error ? <div className="settings-note" data-level="error">{error} Showing the last known readings.</div> : null}
      {reporting.length === 0 ? <div className="usage-empty-card"><h4>No subscription readings yet</h4><p>Codex and the Agent SDK report limits for a signed-in plan. Pi providers report them after a thread on a plan has answered.</p></div> : (
        <div className="usage-account-grid">{reporting.map((account) => <AccountCard key={`${account.runtime}:${account.id}`} account={error ? { ...account, unavailable: { reason: "failed", message: error } } : account} history={limits.history ?? []} rows={rows} periodLabel={periodLabel} now={now} />)}</div>
      )}
      {reporting.length > 0 ? <p className="usage-legend"><span className="usage-legend-diamond" aria-hidden="true" /> The diamond marks steady usage over the window. Each bar is a separate limit.</p> : null}
      {silent.length > 0 ? <details className="usage-disclosure"><summary>Accounts without readings <span>{silent.length}</span></summary>
        <ul className="usage-silent" aria-label="Accounts without limits">{silent.map((account) => <li key={`${account.runtime}:${account.id}`}><strong>{account.label}</strong><span>{account.unavailable?.message ?? "No limits reported."}</span></li>)}</ul>
      </details> : null}
    </div>
  );
}
