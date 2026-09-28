import type { CSSProperties } from "react";
import { CircleAlert, RotateCw, TriangleAlert } from "lucide-react";
import { formatCost, ProviderIconStack, tooltipProps } from "tau";
import { groupAccounts, memberCosts, memberName, type LimitGroup, type MemberCost } from "./accounts.js";
import { PI_BACKEND, type UsageEntry, type UsageLimitAccount, type UsageLimitSample, type UsageLimitWindow, type UsageLimitsSummary } from "./protocol.js";
import { isFresh, quotaState, steadyPercent, type QuotaState } from "./quota.js";
import { toneOf } from "./tones.js";
import { formatWait, resetsIn } from "./view-model.js";

function clockTime(at: number, now: number): string {
  const sameDay = new Date(now).toDateString() === new Date(at).toDateString();
  return new Date(at).toLocaleString(undefined, sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** What a state says beside the reset, and why on hover; nothing while a window is on its way. */
function stateText(state: QuotaState, window: UsageLimitWindow, now: number): { label: string; hint: string; level: "fail" | "warn" | "note" } | undefined {
  switch (state.kind) {
    case "exhausted": return { label: "Limit reached", hint: "This window is used up until it resets.", level: "fail" };
    case "forecast": return { label: `Limit in ${formatWait(state.at - now)}`, hint: `At your recently measured pace this limit runs out around ${clockTime(state.at, now)}, before it resets. The estimate moves with your usage.`, level: "warn" };
    case "pace": return { label: `Past steady pace in ${formatWait(state.at - now)}`, hint: "At your recently measured pace you pass the diamond soon; the diamond moves on too. After that you use more than an even pace allows, but the limit is not used up.", level: "warn" };
    case "ahead": return { label: "Above steady pace", hint: `${Math.round(window.usedPercent)}% used; an even pace would be ${Math.round(state.steady)}% by now. This is not a forecast that the limit runs out.`, level: "warn" };
    case "lasts": return { label: "Lasts until the reset", hint: "At your recently measured pace this limit lasts until it resets.", level: "note" };
    default: return undefined;
  }
}

/**
 * One window: its share used as the figure, the bar, and the diamond where
 * even use over the window would be now; under it the reset and what the
 * recent readings say. A window past its reset shows no figure: the reading
 * no longer describes it.
 */
function WindowLine({ account, window, history, now }: { account: UsageLimitAccount; window: UsageLimitWindow; history: readonly UsageLimitSample[]; now: number }) {
  const used = Math.round(Math.max(0, Math.min(100, window.usedPercent)));
  const state = quotaState(account, window, history, now);
  const expired = state.kind === "expired";
  const steady = expired ? undefined : steadyPercent(window, now);
  const status = stateText(state, window, now);
  const countdown = expired ? "Reset reached · waiting for a new reading" : window.resetsAt ? `${resetsIn(window, now)} · ${clockTime(window.resetsAt, now)}` : "Reset time unavailable";
  const hint = [
    expired ? `${window.label}: the reading is from before its reset.` : `${window.label}: ${used}% used`,
    steady === undefined ? undefined : `Steady pace: ${Math.round(steady)}% by now (the diamond)`,
    window.resetsAt && !expired ? `Resets ${new Date(window.resetsAt).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : undefined,
  ].filter(Boolean).join("\n");
  return (
    <div className="usage-window" data-state={state.kind}>
      <div className="usage-window-head">
        <span className="usage-window-label">{window.label}</span>
        <span className="usage-window-value">{expired ? <b>—</b> : <><b>{used}</b><small>% used</small></>}</span>
      </div>
      <div
        className="usage-meter"
        role="meter"
        aria-label={`${window.label} used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={expired ? 0 : used}
        aria-valuetext={expired ? "reset reached, waiting for a new reading" : `${used}% used${steady === undefined ? "" : `, steady pace ${Math.round(steady)}%`}${status ? `, ${status.label}` : ""}`}
        tabIndex={0}
        {...tooltipProps(hint)}
      >
        {!expired && used > 0 ? <span className="usage-meter-fill" style={{ width: `${used}%` }} /> : null}
        {steady !== undefined ? <span className="usage-meter-pace" style={{ "--usage-pace": `${steady}%` } as CSSProperties} /> : null}
      </div>
      <div className="usage-window-foot">
        <span className="usage-window-reset">{window.resetsAt && !expired ? <RotateCw size={11} aria-hidden="true" /> : null}{countdown}</span>
        {status ? (
          <span className="usage-window-state" data-level={status.level} {...tooltipProps(status.hint)}>
            {status.level === "fail" ? <CircleAlert size={12} aria-hidden="true" /> : status.level === "warn" ? <TriangleAlert size={12} aria-hidden="true" /> : null}
            {status.label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function updated(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return "Updated just now";
  if (minutes < 60) return `Updated ${minutes} min ago`;
  return `Updated ${new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

/** The provider an account's plan belongs to: a Pi login is its provider's, a runtime of its own is itself. */
function providerMark(group: LimitGroup): { modelProvider?: string; runtimeProvider?: string } {
  if (group.members.length > 1 && group.shown.identity) return { modelProvider: group.shown.identity.provider };
  const account = group.members[0]!;
  return account.runtime === PI_BACKEND && account.id.startsWith("pi:") ? { modelProvider: account.id.slice(3) } : { runtimeProvider: account.runtime };
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

/**
 * One account: who it is and its plan, then each window, then where the
 * reading came from. A shared account names its provider and shows the
 * runtimes signed in to it as marks.
 */
function AccountCard({ group, costs, period, history, failed, now }: { group: LimitGroup; costs: MemberCost[] | undefined; period: string; history: readonly UsageLimitSample[]; failed: string | undefined; now: number }) {
  const shown: UsageLimitAccount = failed ? { ...group.shown, unavailable: { reason: "failed", message: failed } } : group.shown;
  const shared = group.members.length > 1;
  const fresh = isFresh(shown, now);
  const title = shared ? group.label.split(" · ")[0]! : group.label;
  const why = shown.unavailable?.message ?? "This reading is more than ten minutes old; read again for the current one.";
  const mark = providerMark(group);
  const tone = { "--usage-tone": `var(--provider-${toneOf(mark.modelProvider ?? mark.runtimeProvider)})` } as CSSProperties;
  return (
    <section className="usage-account" aria-label={`${group.label} limits`} data-fresh={fresh ? undefined : "false"} style={tone}>
      <header>
        <span className="usage-account-mark"><ProviderIconStack {...mark} hint={false} /></span>
        <span className="usage-account-name">
          <strong>{title}</strong>
          {shown.plan ? <small>{shown.plan}</small> : null}
        </span>
        {shared ? (
          <span className="usage-account-runtimes" {...tooltipProps(`${group.members.map(memberName).join(" and ")} are signed in to this account; its limits show once, from the latest read.`, { side: "top" })}>
            {[...new Set(group.members.map((member) => member.runtime.split("@")[0]!))].map((runtime) => <ProviderIconStack key={runtime} runtimeProvider={runtime} hint={false} />)}
          </span>
        ) : null}
        {fresh ? null : <span className="usage-account-stale" tabIndex={0} {...tooltipProps(why, { side: "top" })}>Last known reading</span>}
      </header>
      {shown.windows.map((window) => <WindowLine key={window.id} account={shown} window={window} history={history} now={now} />)}
      {shared && costs ? <SharedCost costs={costs} period={period} /> : null}
      <footer className="usage-account-updated">{updated(shown.checkedAt, now)}{shared ? ` via ${memberName(group.shown)}` : ""}</footer>
    </section>
  );
}

/**
 * How close each plan is to its limits and when they reset, the fullest
 * window first; accounts without windows say why in one line. Runtimes
 * signed in to one account show as one, with their costs summed.
 */
export function UsageLimits({ limits, error, now, entries = [], fromDay = 0, period = "Last 30 days", onRetry }: {
  limits: UsageLimitsSummary | undefined;
  error: string | undefined;
  now: number;
  entries?: readonly UsageEntry[];
  fromDay?: number;
  period?: string;
  onRetry?(): void;
}) {
  if (!limits) {
    return error ? (
      <p className="usage-note" data-level="error">{error} {onRetry ? <button type="button" className="usage-link" onClick={onRetry}>Try again</button> : null}</p>
    ) : <p className="usage-note">Reading limits…</p>;
  }
  const groups = groupAccounts(limits.accounts);
  const fullest = (group: LimitGroup) => Math.max(0, ...group.shown.windows.map((window) => window.usedPercent));
  const reporting = groups.filter((group) => group.shown.windows.length > 0).sort((left, right) => fullest(right) - fullest(left));
  const silent = groups.filter((group) => group.shown.windows.length === 0);
  return (
    <div className="usage-limits" aria-label="Limits">
      {error ? <p className="usage-note" data-level="error">Could not read the limits again: {error} These are the last known readings.</p> : null}
      {reporting.length === 0 ? (
        <p className="usage-note">
          No plan reports its limits yet. Codex and the Agent SDK runtime report them for a signed-in plan; Pi&apos;s providers send
          them with their answers, so they show up here after a thread on a plan has answered.
        </p>
      ) : (
        <>
          <div className="usage-accounts">
            {reporting.map((group) => <AccountCard key={group.key} group={group} costs={memberCosts(group, limits.accounts, entries, fromDay)} period={period} history={limits.history ?? []} failed={error} now={now} />)}
          </div>
          <p className="usage-pace-legend"><i aria-hidden="true" />The diamond is where even use over the window would be now.</p>
        </>
      )}
      {silent.length > 0 ? (
        <ul className="usage-silent" aria-label="Accounts without limits">
          {silent.map((group) => (
            <li key={group.key}>
              <span className="usage-silent-mark"><ProviderIconStack {...providerMark(group)} hint={false} /></span>
              <strong>{group.label}</strong>
              <span>{group.shown.unavailable?.message ?? "No limits reported."}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
