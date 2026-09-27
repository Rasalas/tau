import { formatCost, ProviderIconStack, tooltipProps } from "tau";
import { groupAccounts, memberCosts, memberName, type LimitGroup, type MemberCost } from "./accounts.js";
import type { UsageEntry, UsageLimitAccount, UsageLimitWindow, UsageLimitsSummary } from "./protocol.js";
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

function AccountLimits({ group, costs, period, now }: { group: LimitGroup; costs: MemberCost[] | undefined; period: string; now: number }) {
  const { shown } = group;
  const shared = group.members.length > 1;
  return (
    <section className="usage-account" aria-label={`${group.label} limits`}>
      <header>
        <GroupMarks group={group} />
        <strong {...(shared ? tooltipProps(`${group.members.map(memberName).join(" and ")} are signed in to the same account; its limits show once, from the latest read.`, { side: "top" }) : {})}>{group.label}</strong>
        {shown.plan ? <span className="usage-plan">{shown.plan}</span> : null}
        <small>{checked(shown.checkedAt, now)}{shared ? ` · via ${memberName(shown)}` : ""}</small>
      </header>
      {shown.windows.map((window) => <WindowLine key={window.id} window={window} now={now} />)}
      {shared && costs ? <SharedCost costs={costs} period={period} /> : null}
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
  if (error) return <p className="usage-note" data-level="error">{error}</p>;
  if (!limits) return <p className="usage-note">Reading limits…</p>;
  const groups = groupAccounts(limits.accounts);
  const fullest = (group: LimitGroup) => Math.max(0, ...group.shown.windows.map((window) => window.usedPercent));
  const reporting = groups.filter((group) => group.shown.windows.length > 0).sort((left, right) => fullest(right) - fullest(left));
  const silent = groups.filter((group) => group.shown.windows.length === 0);
  return (
    <div className="usage-limits" aria-label="Limits">
      {reporting.length === 0 ? (
        <p className="usage-note">
          No plan reports its limits yet. Codex and the Agent SDK runtime report them for a signed-in plan; Pi&apos;s providers send
          them with their answers, so they show up here after a thread on a plan has answered.
        </p>
      ) : reporting.map((group) => <AccountLimits key={group.key} group={group} costs={memberCosts(group, limits.accounts, entries, fromDay)} period={period} now={now} />)}
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
