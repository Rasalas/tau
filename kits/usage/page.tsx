import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, formatCost, type HostExtensionClient, type SettingsPageProps } from "tau";
import { UsageLimits } from "./limits.js";
import { ModelPrices } from "./prices.js";
import { USAGE_LIMITS_COMMAND, USAGE_SUMMARY_COMMAND, type UsageLimitsSummary, type UsageSummary, type UsageSummaryInput } from "./protocol.js";
import {
  USAGE_GROUPINGS,
  USAGE_PERIODS,
  formatTokens,
  groupRows,
  periodStart,
  type UsageGrouping,
  type UsagePeriod,
} from "./view-model.js";

const cost = (value: number) => formatCost(value) ?? "—";
const approx = (value: number) => { const money = formatCost(value); return money ? `≈ ${money}` : "—"; };

function Tile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="usage-tile">
      <div className="usage-tile-label">{label}</div>
      <div className="usage-tile-value">{value}</div>
      {detail ? <div className="usage-tile-detail">{detail}</div> : null}
    </div>
  );
}

/**
 * What the threads Tau ran have used, per project, runtime and model, and
 * what each plan has left. Money billed per token and what a subscription
 * covered stay apart: a plan's usage shows its limits and what the same
 * tokens would have cost over the API, never a cost.
 */
export function UsagePage({ host, now }: SettingsPageProps & { host: HostExtensionClient; now?: () => Date }) {
  const [period, setPeriod] = useState<UsagePeriod>("7d");
  const [grouping, setGrouping] = useState<UsageGrouping>("project");
  const [summary, setSummary] = useState<UsageSummary>();
  const [error, setError] = useState<string>();
  const [limits, setLimits] = useState<UsageLimitsSummary>();
  const [limitsError, setLimitsError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const load = useCallback(async (refresh: boolean) => {
    const id = ++request.current;
    setBusy(true);
    const since = periodStart(period, now?.());
    const input: UsageSummaryInput = { ...(since === undefined ? {} : { since }), ...(refresh ? { refresh } : {}) };
    try {
      const result = await host.invoke(USAGE_SUMMARY_COMMAND, input) as UsageSummary;
      if (id !== request.current) return;
      setSummary(result);
      setError(undefined);
    } catch (failure) {
      if (id === request.current) setError(errorMessage(failure));
    } finally {
      if (id === request.current) setBusy(false);
    }
  }, [host, now, period]);

  const loadLimits = useCallback(async (refresh: boolean) => {
    try {
      setLimits(await host.invoke(USAGE_LIMITS_COMMAND, refresh ? { refresh } : {}) as UsageLimitsSummary);
      setLimitsError(undefined);
    } catch (failure) {
      setLimitsError(errorMessage(failure));
    }
  }, [host]);

  useEffect(() => { void load(false); }, [load]);
  useEffect(() => { void loadLimits(false); }, [loadLimits]);

  const groups = useMemo(() => summary ? groupRows(summary.rows, grouping) : [], [grouping, summary]);
  const suggestions = useMemo(() => [...new Set((summary?.rows ?? []).map((row) => row.provider ? `${row.provider}/${row.modelId ?? row.model}` : row.modelId ?? row.model))].sort(), [summary]);
  const totals = summary?.totals;
  const plan = totals?.subscription;
  const periodLabel = USAGE_PERIODS.find((entry) => entry.id === period)?.label ?? "";
  const clock = (now?.() ?? new Date()).getTime();

  return (
    <div className="settings-page usage-page">
      <h3>Usage</h3>
      <p className="lede">
        What the threads Tau ran have used, from what each runtime recorded, and what each subscription has left. Money billed per token
        and what a plan covered are kept apart: a plan&apos;s usage shows its limits and what the same tokens would have cost over the API.
        Nothing here is a bill.
      </p>

      <div className="usage-controls">
        <div className="segmented" role="group" aria-label="Period">
          {USAGE_PERIODS.map((entry) => (
            <button key={entry.id} type="button" className={period === entry.id ? "active" : ""} aria-pressed={period === entry.id} onClick={() => setPeriod(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <button type="button" className="usage-refresh" disabled={busy} onClick={() => { void load(true); void loadLimits(true); }}>
          {busy ? "Reading…" : "Read again"}
        </button>
      </div>

      <div className="settings-label">Subscription limits</div>
      <UsageLimits limits={limits} error={limitsError} rows={summary?.rows} periodLabel={periodLabel} now={clock} />

      {error ? <div className="settings-note" data-level="error">{error}</div> : null}

      {totals && plan ? (
        <div className="usage-tiles" aria-label="Totals">
          <Tile label="Billed via API" value={cost(totals.costUsd)} detail={totals.costUsd > 0 ? "API keys, priced per token" : "nothing billed per token in this period"} />
          <Tile
            label="On a subscription"
            value={plan.totalTokens > 0 ? approx(plan.apiValueUsd) : "—"}
            detail={plan.totalTokens > 0 ? `would have cost via the API · ${formatTokens(plan.totalTokens)} tokens, included` : "no plan usage in this period"}
          />
          <Tile label="Tokens" value={formatTokens(totals.totalTokens)} detail={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatTokens(totals.cacheReadTokens)} cache read`} />
          <Tile label="Threads" value={String(totals.threads)} detail={`${totals.requests} requests`} />
        </div>
      ) : !error ? (
        <div className="settings-note">Reading usage…</div>
      ) : null}

      {summary ? (
        <>
          <div className="settings-label usage-table-head">
            <span>{periodLabel} · by</span>
            <div className="segmented" role="group" aria-label="Group by">
              {USAGE_GROUPINGS.map((entry) => (
                <button key={entry.id} type="button" className={grouping === entry.id ? "active" : ""} aria-pressed={grouping === entry.id} onClick={() => setGrouping(entry.id)}>
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          {groups.length > 0 ? (
            <table className="inspector-table usage-table" aria-label="Usage">
              <thead>
                <tr>
                  <th>{USAGE_GROUPINGS.find((entry) => entry.id === grouping)?.label}</th>
                  {grouping === "all" ? <th className="usage-number">Threads</th> : null}
                  <th className="usage-number">Requests</th>
                  <th className="usage-number">Input</th>
                  <th className="usage-number">Output</th>
                  <th className="usage-number">Cache read</th>
                  <th className="usage-number" title="Money billed per token">Billed</th>
                  <th className="usage-number" title="What a subscription covered would have cost over the API">Plan value</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.key}>
                    <td>
                      <strong>{group.label}</strong>
                      {group.detail ? <small title={group.title ?? group.detail}>{group.detail}</small> : null}
                    </td>
                    {grouping === "all" ? <td className="usage-number">{group.threads ?? 0}</td> : null}
                    <td className="usage-number">{group.requests}</td>
                    <td className="usage-number">{formatTokens(group.inputTokens)}</td>
                    <td className="usage-number">{formatTokens(group.outputTokens)}</td>
                    <td className="usage-number">{formatTokens(group.cacheReadTokens)}</td>
                    <td className="usage-number">{cost(group.costUsd)}</td>
                    <td className="usage-number usage-plan-value">{group.planTokens > 0 ? approx(group.apiValueUsd) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="settings-note usage-empty">
              Nothing was recorded {period === "all" ? "yet" : "in this period"}. Usage appears here once a thread has answered: Pi writes
              every response with its tokens into its session files, and the Codex, Agent SDK and Antigravity kits keep every turn.
              The sources below say what was read.
            </div>
          )}

          <div className="settings-label">Model prices</div>
          <ModelPrices suggestions={suggestions} />

          <div className="settings-label">Sources</div>
          <ul className="usage-sources" aria-label="Sources">
            {summary.sources.map((source) => (
              <li key={source.backend} data-status={source.status}>
                <strong>{source.label}</strong>
                <em className="usage-status">{source.status === "ok" ? "read" : source.status === "empty" ? "no data" : "not available"}</em>
                <span>{source.detail}</span>
              </li>
            ))}
            {limits?.sources.map((source) => (
              <li key={`limits-${source.extensionId}`} data-status={source.status}>
                <strong>{source.label} limits</strong>
                <em className="usage-status">{source.status === "ok" ? "read" : source.status === "empty" ? "no data" : "not available"}</em>
                <span>{source.detail}</span>
              </li>
            ))}
          </ul>
          <div className="settings-note">
            Billed is what an API key was charged per token, as the runtime or your own price put it. Plan value is what a subscription&apos;s
            tokens would have cost over the provider&apos;s API; the plan itself was paid for already. A model without a price counts tokens
            only. Last read {new Date(summary.scannedAt).toLocaleTimeString()}.
          </div>
        </>
      ) : null}
    </div>
  );
}
