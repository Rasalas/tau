import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { UiRuntimeTool, UiRuntimeToolLogEntry, UiRuntimeToolsState } from "../../shared/contracts";
import { compareVersions } from "../../shared/runtime-version";
import { errorMessage } from "../../workbench/error-message";
import { useHostClient } from "../host-client-context";
import { Badge, Button, Switch } from "./controls";
import { formatAgo } from "./connections-format";
import { SettingRow, SettingsSection } from "./settings-layout";
import { settingAnchor } from "./settings-search";

/** While something runs, the page asks this often how it stands. */
const POLL_MS = 2_000;
const LOG_SHOWN = 8;

type Change = "automatic" | "update" | "switch";

const pending = (tool: UiRuntimeTool) => Boolean(tool.installed && tool.latest && compareVersions(tool.installed, tool.latest) < 0);

function toolBadge(tool: UiRuntimeTool) {
  if (tool.state === "updating") return <Badge tone="accent" dot>Updating…</Badge>;
  if (tool.state === "switching") return <Badge tone="accent" dot>Switching…</Badge>;
  if (tool.state === "waiting") return <Badge>Waits for its turns</Badge>;
  if (pending(tool)) return <Badge tone="accent" dot>{tool.latest} available</Badge>;
  if (tool.installed && tool.latest) return <Badge tone="success">Up to date</Badge>;
  return null;
}

const OUTCOMES: Record<UiRuntimeToolLogEntry["outcome"], { tone: "success" | "danger" | "neutral" | "warn"; text: string }> = {
  ok: { tone: "success", text: "Done" },
  failed: { tone: "danger", text: "Failed" },
  waiting: { tone: "neutral", text: "Waiting" },
  unchanged: { tone: "warn", text: "Unchanged" },
};

function LogEntry({ entry, now }: { entry: UiRuntimeToolLogEntry; now: number }) {
  const outcome = OUTCOMES[entry.outcome];
  const versions = entry.from && entry.to && entry.from !== entry.to ? ` ${entry.from} → ${entry.to}` : "";
  return (
    <li className="runtime-tools-log-entry" data-outcome={entry.outcome}>
      <div className="runtime-tools-log-head">
        <Badge tone={outcome.tone}>{outcome.text}</Badge>
        <span>{entry.label}{versions}</span>
        <time dateTime={new Date(entry.at).toISOString()}>{formatAgo(new Date(entry.at).toISOString(), now)}</time>
      </div>
      {entry.command ? <code>{entry.command}</code> : null}
      {entry.message ? <p>{entry.message}</p> : null}
      {entry.output && entry.outcome !== "ok" ? (
        <details>
          <summary>Output</summary>
          <pre>{entry.output}</pre>
        </details>
      ) : null}
    </li>
  );
}

/**
 * Settings → Runtimes, below the table (K124): whether Tau keeps the agent
 * CLIs current on this machine, each program with where it comes from and
 * what updates it, a lagging source with the switch the user may ask for,
 * the log of what ran, and Refresh, which asks every runtime for its version
 * and models again.
 */
export function RuntimeToolsSection({ onNotify }: { onNotify(message: string): void }) {
  const client = useHostClient();
  const [state, setState] = useState<UiRuntimeToolsState>();
  const [problem, setProblem] = useState<string>();
  const [working, setWorking] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const readOnly = client?.isReadOnly() === true || client?.isOwner?.() === false;

  const read = useCallback(() => client?.runtimeTools?.("state").then(setState, (error: unknown) => setProblem(errorMessage(error))), [client]);
  useEffect(() => { void read(); }, [read]);
  const running = state?.tools.some((tool) => tool.state) === true;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void read(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, read]);

  if (!client?.runtimeTools || !state) return null;
  const change = (id: string, action: Change, input: { on?: boolean; kind?: string }, done?: string) => {
    setWorking(id);
    setProblem(undefined);
    client.runtimeTools!(action, input)
      .then((next) => { setState(next); if (done) onNotify(done); })
      .catch((error: unknown) => setProblem(errorMessage(error)))
      .finally(() => setWorking(undefined));
  };
  const refresh = () => {
    setWorking("refresh");
    setProblem(undefined);
    client.runtimeTools!("refresh")
      .then((next) => { setState(next); onNotify("Every runtime was asked for its version and models again."); })
      .catch((error: unknown) => setProblem(errorMessage(error)))
      .finally(() => setWorking(undefined));
  };
  const cannot = state.blocked ?? (readOnly ? "Read only: this needs a device with Full access." : undefined);
  const now = Date.now();
  const names = state.tools.filter((tool) => tool.update).map((tool) => tool.label);

  return (
    <SettingsSection
      title="Agent tools"
      id={settingAnchor("Keep agent tools up to date")}
      headerAction={<Button variant="ghost" icon={<RefreshCw size={13} aria-hidden />} busy={working === "refresh"} disabled={working === "refresh"} onClick={refresh}>Refresh</Button>}
    >
      <SettingRow
        title="Keep agent tools up to date"
        description={`Installs a new release${names.length ? ` of ${names.join(", ")}` : ""} with the package manager that installed it, once none of its turns runs. Checks every six hours; on this machine only.`}
        disabledReason={cannot}
        control={<Switch label="Keep agent tools up to date" checked={state.automatic === true} disabled={cannot !== undefined || working === "automatic"} onChange={(on) => change("automatic", "automatic", { on })} />}
      />
      {state.tools.map((tool) => {
        const kind = tool.kinds[0]!;
        const busy = working === `update:${kind}` || tool.state === "updating" || tool.state === "switching";
        return (
          <SettingRow
            key={kind}
            title={<>{tool.label} {tool.installed ?? ""} {toolBadge(tool)}</>}
            description={<>From {tool.source}.{tool.update ? <> Updates with <code>{tool.update}</code>.</> : tool.note ? ` ${tool.note}` : ""}</>}
            disabledReason={tool.update ? cannot : undefined}
            control={tool.update && pending(tool) ? (
              <Button variant="primary" busy={busy} disabled={busy || cannot !== undefined || tool.state === "waiting"} onClick={() => change(`update:${kind}`, "update", { kind })}>
                {busy ? "Updating…" : "Update now"}
              </Button>
            ) : null}
          >
            {tool.behind ? (
              <div className="runtime-tools-behind" role="note">
                <p>{`${tool.behind.source === "homebrew" ? "Homebrew" : tool.behind.source} has ${tool.behind.latest}, ${tool.behind.newer.source} ${tool.behind.newer.latest}.`}</p>
                {tool.switchSteps && confirming !== kind ? (
                  <Button disabled={cannot !== undefined || busy} onClick={() => setConfirming(kind)}>{`Switch to ${tool.behind.newer.source}`}</Button>
                ) : null}
                {tool.switchSteps && confirming === kind ? (
                  <div className="runtime-tools-confirm">
                    <p>Tau runs, in this order:</p>
                    <ol>{tool.switchSteps.map((step) => <li key={step}><code>{step}</code></li>)}</ol>
                    <p>If the second step fails, the Homebrew install comes back.</p>
                    <Button variant="ghost" onClick={() => setConfirming(undefined)}>Cancel</Button>
                    <Button variant="primary" onClick={() => { setConfirming(undefined); change(`update:${kind}`, "switch", { kind }); }}>Switch</Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </SettingRow>
        );
      })}
      {problem ? <p className="settings-group-note machine-warning" role="alert">{problem}</p> : null}
      {state.log.length ? (
        <SettingRow title="Recent activity" description="What Tau ran to keep the agent tools current, newest first.">
          <ul className="runtime-tools-log">{state.log.slice(0, LOG_SHOWN).map((entry) => <LogEntry key={`${entry.at}-${entry.label}-${entry.action}-${entry.outcome}`} entry={entry} now={now} />)}</ul>
        </SettingRow>
      ) : null}
    </SettingsSection>
  );
}
