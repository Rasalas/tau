import { formatCost, type UiThreadUsage } from "tau";
import { apiValue, type ThreadCostSummary } from "./thread-cost.js";

const tokens = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const PROVIDERS: Readonly<Record<string, string>> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", "google-gemini-cli": "Google", xai: "xAI", unknown: "Other" };

export function costLabel(usage: UiThreadUsage): string | undefined {
  const value = formatCost(apiValue(usage));
  if (value) return `${usage.subscription ? "≈ " : ""}${value}`;
  return usage.totalTokens > 0 ? `${tokens.format(usage.totalTokens)} tokens` : undefined;
}

/** A single total, its provider shares, then the token split. Plan value never reads as a bill. */
export function ThreadCostDetails({ summary }: { summary: ThreadCostSummary }) {
  const { usage, providers, subagents } = summary;
  const plan = usage.subscription;
  const priced = apiValue(usage) > 0;
  const mixed = plan && usage.costUsd > 0;
  const split = [["Input", usage.inputTokens], ["Output", usage.outputTokens], ["Cache read", usage.cacheReadTokens], ["Cache write", usage.cacheWriteTokens]] as const;
  return <>
    <header className="thread-cost-total">
      <span>{priced ? plan ? "API equivalent" : "API cost" : "Tokens"}</span>
      <strong>{priced ? formatCost(apiValue(usage)) : tokens.format(usage.totalTokens)}</strong>
      <small>{plan ? mixed ? "Plan + API" : "Included in plan" : priced ? "Billed via API" : "Price unavailable"}</small>
    </header>
    {mixed ? <div className="thread-cost-billing"><table>
      <thead><tr><th>Provider</th><th>Plan value</th><th>API billed</th></tr></thead>
      <tbody>{providers.map((item) => <tr key={item.provider}>
        <th>{PROVIDERS[item.provider] ?? item.provider}</th>
        <td>{formatCost(item.usage.subscription?.apiValueUsd ?? 0) ?? "—"}</td>
        <td>{formatCost(item.usage.costUsd) ?? "—"}</td>
      </tr>)}</tbody>
    </table></div> : providers.length > 1 ? <dl className="thread-cost-providers">
      {providers.map((item) => <div key={item.provider}><dt>{PROVIDERS[item.provider] ?? item.provider}</dt><dd>{formatCost(apiValue(item.usage)) ?? "—"}</dd></div>)}
    </dl> : null}
    <dl className="thread-cost-tokens">{split.map(([name, count]) => <div key={name}><dt>{name}</dt><dd>{tokens.format(count)}</dd></div>)}</dl>
    <footer className="thread-cost-footnote">
      {providers.length === 1 && !mixed ? <span>{PROVIDERS[providers[0]!.provider] ?? providers[0]!.provider}</span> : null}
      <span>{usage.turns} {usage.turns === 1 ? "turn" : "turns"}</span>
      {subagents > 0 ? <span>{subagents} {subagents === 1 ? "linked subagent" : "linked subagents"}</span> : null}
    </footer>
  </>;
}
