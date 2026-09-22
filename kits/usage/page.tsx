import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage, formatCost, type HostExtensionClient, type SettingsPageProps } from "tau";
import { USAGE_SUMMARY_COMMAND, type UsageSummary, type UsageSummaryInput } from "./protocol.js";
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
 * What the threads Tau ran have used, per project, runtime and model. The
 * numbers are the ones each runtime wrote down; nothing is fetched from a
 * provider, and a cost is the runtime's own pricing, not a bill.
 */
export function UsagePage({ host, now }: SettingsPageProps & { host: HostExtensionClient; now?: () => Date }) {
  const [period, setPeriod] = useState<UsagePeriod>("7d");
  const [grouping, setGrouping] = useState<UsageGrouping>("project");
  const [summary, setSummary] = useState<UsageSummary>();
  const [error, setError] = useState<string>();
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

  useEffect(() => { void load(false); }, [load]);

  const groups = useMemo(() => summary ? groupRows(summary.rows, grouping) : [], [grouping, summary]);
  const totals = summary?.totals;
  const periodLabel = USAGE_PERIODS.find((entry) => entry.id === period)?.label ?? "";

  return (
    <div className="settings-page usage-page">
      <h3>Usage</h3>
      <p className="lede">
        What the threads Tau ran have used, from what each runtime recorded: every response in Pi&apos;s session files, and the
        running total the Claude Code and Antigravity kits keep per thread. Nothing is asked of a provider, and nothing here is a bill.
      </p>

      <div className="usage-controls">
        <div className="segmented" role="group" aria-label="Period">
          {USAGE_PERIODS.map((entry) => (
            <button key={entry.id} type="button" className={period === entry.id ? "active" : ""} aria-pressed={period === entry.id} onClick={() => setPeriod(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <button type="button" className="usage-refresh" disabled={busy} onClick={() => void load(true)}>
          {busy ? "Reading…" : "Read again"}
        </button>
      </div>

      {error ? <div className="settings-note" data-level="error">{error}</div> : null}

      {totals ? (
        <div className="usage-tiles" aria-label="Totals">
          <Tile label="COST" value={cost(totals.costUsd)} detail={totals.costUsd > 0 ? "as the runtimes priced it" : "no priced model in this period"} />
          <Tile label="TOKENS" value={formatTokens(totals.totalTokens)} detail={`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatTokens(totals.cacheReadTokens)} cache read`} />
          <Tile label="REQUESTS" value={String(totals.requests)} />
          <Tile label="THREADS" value={String(totals.threads)} />
        </div>
      ) : !error ? (
        <div className="settings-note">Reading usage…</div>
      ) : null}

      {summary ? (
        <>
          <div className="settings-label usage-table-head">
            <span>{periodLabel.toUpperCase()} · BY</span>
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
                  <th className="usage-number">Cost</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.key}>
                    <td>
                      <strong>{group.label}</strong>
                      {group.detail ? <small title={group.detail}>{group.detail}</small> : null}
                    </td>
                    {grouping === "all" ? <td className="usage-number">{group.threads ?? 0}</td> : null}
                    <td className="usage-number">{group.requests}</td>
                    <td className="usage-number">{formatTokens(group.inputTokens)}</td>
                    <td className="usage-number">{formatTokens(group.outputTokens)}</td>
                    <td className="usage-number">{formatTokens(group.cacheReadTokens)}</td>
                    <td className="usage-number">{cost(group.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="settings-note usage-empty">
              Nothing was recorded {period === "all" ? "yet" : "in this period"}. Usage appears here once a thread has answered: Pi writes
              every response with its tokens into its session files, and the Claude Code and Antigravity kits keep a running total per
              thread. The sources below say what was read.
            </div>
          )}

          <div className="settings-label">SOURCES</div>
          <ul className="usage-sources" aria-label="Sources">
            {summary.sources.map((source) => (
              <li key={source.backend} data-status={source.status}>
                <strong>{source.label}</strong>
                <em className="usage-status">{source.status === "ok" ? "read" : source.status === "empty" ? "no data" : "not available"}</em>
                <span>{source.detail}</span>
              </li>
            ))}
          </ul>
          <div className="settings-note">
            Cost is what the runtime priced the tokens at when it answered. A subscription bills differently, and a model without a price
            counts tokens only. Last read {new Date(summary.scannedAt).toLocaleTimeString()}.
          </div>
        </>
      ) : null}
    </div>
  );
}
