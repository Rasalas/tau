import type { ReactNode } from "react";
import { formatCost, ProviderIconStack, tooltipProps } from "tau";
import { measure, type RankedUsage, type UsageMetric } from "./dashboard.js";
import { formatTokens } from "./view-model.js";

export interface RankRow {
  item: RankedUsage;
  name: string;
  /** The line under the name. */
  detail?: string;
  /** What the name's hover says: a whole path, say. */
  title?: string;
  /** The runtime and provider marks, when the row is about them. */
  marks?: { runtimeProvider?: string; modelProvider?: string };
  onOpen?(): void;
}

/** A row's figures: money billed and a plan's value apart, or tokens; tokens when nothing priced it. */
function Figures({ item, metric }: { item: RankedUsage; metric: UsageMetric }) {
  const billed = formatCost(item.costUsd);
  const plan = formatCost(item.apiValueUsd);
  if (metric === "tokens" || (!billed && !plan)) return <span className="usage-rank-value">{formatTokens(item.totalTokens)} tok</span>;
  return (
    <span className="usage-rank-value">
      {billed ? <b>{billed}</b> : null}
      {plan ? <em {...tooltipProps("What a plan covered, at API prices")}>≈ {plan}</em> : null}
    </span>
  );
}

/** One ranking: the name, a bar against the first row, the figures. */
export function RankList({ title, rows, metric, empty }: { title: string; rows: readonly RankRow[]; metric: UsageMetric; empty: ReactNode }) {
  const top = Math.max(1e-9, ...rows.map((row) => measure(row.item, metric) || (metric === "cost" ? 0 : row.item.totalTokens)));
  return (
    <section className="usage-rank" aria-label={title}>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="usage-note">{empty}</p> : (
        <ol>
          {rows.map((row) => {
            const value = measure(row.item, metric);
            const billedShare = metric === "cost" ? row.item.costUsd / top : row.item.totalTokens / top;
            const planShare = metric === "cost" ? row.item.apiValueUsd / top : 0;
            const label = (
              <>
                {row.marks ? <ProviderIconStack {...row.marks} hint={{ side: "top" }} /> : null}
                <span className="usage-rank-name">
                  <strong {...(row.title ? tooltipProps(row.title, { side: "top" }) : {})}>{row.name}</strong>
                  {row.detail ? <small>{row.detail}</small> : null}
                </span>
              </>
            );
            return (
              <li key={row.item.key}>
                {row.onOpen ? <button type="button" className="usage-rank-label" onClick={row.onOpen}>{label}</button> : <div className="usage-rank-label">{label}</div>}
                <span className="usage-rank-bar" aria-hidden="true" data-empty={value > 0 ? undefined : "true"}>
                  {billedShare > 0 ? <i className={metric === "tokens" ? "tokens" : "billed"} style={{ width: `${billedShare * 100}%` }} /> : null}
                  {planShare > 0 ? <i className="plan" style={{ width: `${planShare * 100}%` }} /> : null}
                </span>
                <Figures item={row.item} metric={metric} />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
