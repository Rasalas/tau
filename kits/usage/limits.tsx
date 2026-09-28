import { formatCost, ProviderIconStack, tooltipProps } from "tau";
import { groupAccounts, memberCosts, memberName, type LimitGroup, type MemberCost } from "./accounts.js";
import type { UsageEntry, UsageLimitAccount, UsageLimitSample, UsageLimitWindow, UsageLimitsSummary } from "./protocol.js";
import { FRESH_MS, providerOf, providerTone, quotaState } from "./quota.js";
import { elapsedShare, resetsIn } from "./view-model.js";

function WindowRow({ account, window, history, now }: { account: UsageLimitAccount; window: UsageLimitWindow; history: readonly UsageLimitSample[]; now: number }) {
  const used = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
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

function checked(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  return `Last read ${new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

/** A Pi account is one provider's login: its mark is the provider's, through Pi. */
function accountMarks(account: UsageLimitAccount): { modelProvider?: string; runtimeProvider: string } {
  const provider = account.runtime === "pi" && account.id.startsWith("pi:") ? account.id.slice(3) : undefined;
  return { ...(provider ? { modelProvider: provider } : {}), runtimeProvider: account.runtime };
}

function GroupMarks({ group }: { group: LimitGroup }) {
  return <>{group.members.map((member) => <ProviderIconStack key={`${member.runtime}:${member.id}`} {...accountMarks(member)} hint={{ side: "top" }} />)}</>;
}

/** Billed money and a plan's value, never one figure. */
function money(figures: { costUsd: number; apiValueUsd: number }): string {
  const plan = formatCost(figures.apiValueUsd);
  const billed = formatCost(figures.costUsd);
  return [plan ? `≈ ${plan} plan value` : undefined, billed ? `${billed} billed` : undefined].filter(Boolean).join(" + ") || "$0";
}

/** A shared account's money: the runtimes' together, then each on its own. */
function SharedCost({ costs, period }: { costs: MemberCost[]; period: string }) {
  const total = costs.reduce((sum, cost) => ({ costUsd: sum.costUsd + cost.costUsd, apiValueUsd: sum.apiValueUsd + cost.apiValueUsd }), { costUsd: 0, apiValueUsd: 0 });
  return (
    <p className="usage-account-cost">
      {period}: <b>{money(total)}</b>
      <span> ({costs.map((cost) => `${cost.name} ${money(cost).replace(/ plan value/gu, "")}`).join(", ")})</span>
    </p>
  );
}

function AccountCard({ group, costs, period, history, failed, now }: { group: LimitGroup; costs: MemberCost[] | undefined; period: string; history: readonly UsageLimitSample[]; failed: string | undefined; now: number }) {
  const shown: UsageLimitAccount = failed ? { ...group.shown, unavailable: { reason: "failed", message: failed } } : group.shown;
  const shared = group.members.length > 1;
  const stale = !!shown.unavailable || now - shown.checkedAt > FRESH_MS || shown.checkedAt > now;
  const provider = providerOf(shown);
  return (
    <section className="usage-account" aria-label={`${group.label} limits`} data-provider={providerTone(provider)}>
      <header>
        <div className="usage-provider-mark"><GroupMarks group={group} /></div>
        <div className="usage-account-heading">
          <strong {...(shared ? tooltipProps(`${group.members.map(memberName).join(" and ")} are signed in to the same account; its limits show once, from the latest read.`, { side: "top" }) : {})}>{group.label}</strong>
          <span>{shown.plan ?? "Subscription"}</span>
        </div>
        <small data-stale={stale || undefined}>{stale ? "Last known reading" : "Live reading"}</small>
      </header>
      <div className="usage-windows">
        {shown.windows.map((window) => <WindowRow key={window.id} account={shown} window={window} history={history} now={now} />)}
      </div>
      {shared && costs ? <SharedCost costs={costs} period={period} /> : null}
      <footer className="usage-account-checked">{checked(shown.checkedAt, now)}{shared ? ` · via ${memberName(group.shown)}` : ""}</footer>
    </section>
  );
}

/**
 * How close each plan is to its limits and when they reset, the fullest
 * window first; accounts without windows say why in one line. Runtimes
 * signed in to one account show as one, with their costs summed.
 */
export function UsageLimits({ limits, error, now, entries = [], fromDay = 0, period = "Last 30 days" }: {
  limits: UsageLimitsSummary | undefined;
  error: string | undefined;
  now: number;
  entries?: readonly UsageEntry[];
  fromDay?: number;
  period?: string;
}) {
  if (!limits) return <p className="usage-note" data-level={error ? "error" : undefined}>{error ?? "Reading limits…"}</p>;
  const groups = groupAccounts(limits.accounts);
  const fullest = (group: LimitGroup) => Math.max(0, ...group.shown.windows.map((window) => window.usedPercent));
  const reporting = groups.filter((group) => group.shown.windows.length > 0).sort((left, right) => fullest(right) - fullest(left));
  const silent = groups.filter((group) => group.shown.windows.length === 0);
  return (
    <div className="usage-limits" aria-label="Limits">
      {error ? <p className="usage-note" data-level="error">{error} Showing the last known readings.</p> : null}
      {reporting.length === 0 ? (
        <div className="usage-empty-card"><h4>No subscription readings yet</h4><p>Codex and the Agent SDK report limits for a signed-in plan. Pi providers report them after a thread on a plan has answered.</p></div>
      ) : (
        <div className="usage-account-grid">
          {reporting.map((group) => <AccountCard key={group.key} group={group} costs={memberCosts(group, limits.accounts, entries, fromDay)} period={period} history={limits.history ?? []} failed={error} now={now} />)}
        </div>
      )}
      {reporting.length > 0 ? <p className="usage-legend"><span className="usage-legend-diamond" aria-hidden="true" /> The diamond marks steady usage over the window. Each bar is a separate limit.</p> : null}
      {silent.length > 0 ? (
        <ul className="usage-silent" aria-label="Accounts without limits">
          {silent.map((group) => (
            <li key={group.key}>
              <GroupMarks group={group} />
              <span {...tooltipProps(group.shown.unavailable?.message ?? "No limits reported.", { side: "top" })}><strong>{group.label}</strong> {group.shown.unavailable?.message ?? "No limits reported."}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
