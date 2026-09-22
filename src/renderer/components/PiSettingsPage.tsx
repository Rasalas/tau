import { useEffect, useState } from "react";
import type { HostSnapshot, TauConfig } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";
import { SettingRow, SettingsSection } from "../settings/settings-layout";

/**
 * Pi's own settings, the ones Pi reads from `~/.pi/agent/settings.json` and
 * applies itself. Tau mirrors them for reading and writes them back to that
 * file through `update-config`, so the workbench and the Pi CLI share one
 * configuration instead of Tau keeping a copy nothing acts on.
 */
const PI_BUILTIN_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

/** A text field that keeps what is typed locally and commits it on blur or Enter. */
function PiTextField({
  label,
  hint,
  value,
  placeholder,
  disabled,
  commit,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  commit(value: string): void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const send = () => { if (draft.trim() && draft.trim() !== value.trim()) commit(draft.trim()); };
  return (
    <SettingRow
      title={label}
      description={hint}
      control={<input
        aria-label={label}
        type="text"
        className="settings-input"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={send}
        onKeyDown={(event) => { if (event.key === "Enter") send(); }}
      />}
    />
  );
}

/** A whole number that is written when focus leaves the field. */
function PiNumberField({
  label,
  hint,
  value,
  placeholder,
  disabled,
  commit,
}: {
  label: string;
  hint?: string;
  value: number | undefined;
  placeholder?: string;
  disabled?: boolean;
  commit(value: number): void;
}) {
  const [draft, setDraft] = useState(value !== undefined ? String(value) : "");
  useEffect(() => { setDraft(value !== undefined ? String(value) : ""); }, [value]);
  const send = () => {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed) && parsed !== value) commit(parsed);
  };
  return (
    <SettingRow
      title={label}
      description={hint}
      control={<input
        aria-label={label}
        type="number"
        className="settings-input narrow"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={send}
        onKeyDown={(event) => { if (event.key === "Enter") send(); }}
      />}
    />
  );
}

function PiToggleRow({ label, hint, checked, disabled, onChange }: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <SettingRow
      title={label}
      description={hint}
      control={<button
        className={`switch ${checked ? "on" : ""}`}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <i />
      </button>}
    />
  );
}

export function PiSettingsPage({ snapshot, onNotify }: { snapshot?: HostSnapshot; onNotify(message: string): void }) {
  const client = useHostClient();
  // The opaque id is how a workspace is addressed; `cwd` is display data.
  const workspaceId = snapshot?.workspaceId ?? snapshot?.cwd;
  const [config, setConfig] = useState<TauConfig>();
  const [scope, setScope] = useState<"global" | "project">("global");

  useEffect(() => {
    let cancelled = false;
    client?.getConfig(workspaceId)
      .then((next) => { if (!cancelled) setConfig(next); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [client, workspaceId]);

  const write = (patch: Partial<TauConfig>) => {
    if (!client) return;
    client.updateConfig(patch, scope, workspaceId)
      .then((next) => setConfig(next))
      .catch((error: unknown) => onNotify(error instanceof Error ? error.message : String(error)));
  };

  if (!client) {
    return <div className="settings-page"><p className="lede">Pi's settings need a host connection.</p></div>;
  }
  // Nothing is drawn before the file has been read: a control that shows a
  // default while the real value is still on its way would be a guess.
  if (!config) {
    return <div className="settings-page"><p className="lede">Reading Pi's settings…</p></div>;
  }

  const compaction = config.compaction ?? {};
  const retry = config.retry ?? {};
  const tools = config.defaultTools;

  const modeGroup = (label: string, current: "all" | "one-at-a-time" | undefined, key: "steeringMode" | "followUpMode") => (
    <div className="segmented" role="group" aria-label={label}>
      {(["one-at-a-time", "all"] as const).map((mode) => (
        <button key={mode} className={(current ?? "one-at-a-time") === mode ? "active" : ""} onClick={() => write({ [key]: mode })}>
          {mode === "all" ? "All at once" : "One at a time"}
        </button>
      ))}
    </div>
  );

  return (
    <div className="settings-page">
      <p className="lede">
        Pi's own settings, in <code>~/.pi/agent/settings.json</code> and <code>&lt;project&gt;/.pi/settings.json</code>.
        Tau reads and writes that file, so the Pi CLI sees the same configuration. A change applies to the next
        runtime Tau builds; a thread that is already running keeps what it started with.
      </p>

      <SettingsSection title="Scope">
        <SettingRow
          title="Write Pi settings to"
          description={scope === "project"
            ? <>Writes to <code>{snapshot?.cwd}/.pi/settings.json</code>.</>
            : <>Writes to <code>~/.pi/agent/settings.json</code>.</>}
          control={<div className="segmented" role="group" aria-label="Settings scope">
            <button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>All projects</button>
            <button
              className={scope === "project" ? "active" : ""}
              aria-pressed={scope === "project"}
              disabled={!snapshot?.cwd}
              onClick={() => setScope("project")}
            >
              This project
            </button>
          </div>}
        />
      </SettingsSection>

      <SettingsSection title="Startup model">
        <PiTextField
          label="Model"
          hint="provider/modelId, e.g. anthropic/claude-sonnet-4"
          value={config.models?.default ?? ""}
          placeholder="unset"
          commit={(value) => write({ models: { ...config.models, default: value } })}
        />
        <PiTextField
          label="Thinking level"
          hint="off, minimal, low, medium, high, xhigh or max"
          value={config.models?.thinkingLevel ?? ""}
          placeholder="unset"
          commit={(value) => write({ models: { ...config.models, thinkingLevel: value } })}
        />
      </SettingsSection>

      <SettingsSection title="Compaction">
        <PiToggleRow
          label="Automatic compaction"
          hint="Summarize the conversation when it approaches the context window."
          checked={compaction.enabled !== false}
          onChange={(enabled) => write({ compaction: { ...compaction, enabled } })}
        />
        <PiNumberField
          label="Reserve tokens"
          hint="Held back for the model's reply"
          value={compaction.reserveTokens}
          placeholder="16384"
          commit={(reserveTokens) => write({ compaction: { ...compaction, reserveTokens } })}
        />
        <PiNumberField
          label="Keep recent tokens"
          hint="Left unsummarized"
          value={compaction.keepRecentTokens}
          placeholder="20000"
          commit={(keepRecentTokens) => write({ compaction: { ...compaction, keepRecentTokens } })}
        />
      </SettingsSection>

      <SettingsSection title="Retry">
        <PiToggleRow
          label="Retry on transient errors"
          hint="Pi retries a failed agent turn with exponential backoff."
          checked={retry.enabled !== false}
          onChange={(enabled) => write({ retry: { ...retry, enabled } })}
        />
        <PiNumberField
          label="Max retries"
          value={retry.maxRetries}
          placeholder="3"
          commit={(maxRetries) => write({ retry: { ...retry, maxRetries } })}
        />
        <PiNumberField
          label="Base delay (ms)"
          hint="2s, then doubled per attempt"
          value={retry.baseDelayMs}
          placeholder="2000"
          commit={(baseDelayMs) => write({ retry: { ...retry, baseDelayMs } })}
        />
      </SettingsSection>

      <SettingsSection title="Message delivery">
        <SettingRow title="Steering messages" description="Sent while the agent is running" control={modeGroup("Steering messages", config.steeringMode, "steeringMode")} />
        <SettingRow title="Follow-up messages" description="Queued behind the current turn" control={modeGroup("Follow-up messages", config.followUpMode, "followUpMode")} />
      </SettingsSection>

      <SettingsSection title="Built-in tools">
        <SettingRow
          title="Tools"
          description={tools === undefined
            ? "Pi's standard set is in use. Choosing any of them pins the list; choosing none turns every built-in tool off, which Pi allows on purpose. Extension and SDK tools are not affected."
            : "This list is pinned. Choosing none turns every built-in tool off. Extension and SDK tools are not affected."}
        >
          <div className="chip-row settings-row-extra">
            {PI_BUILTIN_TOOLS.map((tool) => {
              const selected = tools === undefined || tools.includes(tool);
              return (
                <button
                  key={tool}
                  type="button"
                  className="chip"
                  aria-pressed={selected}
                  title={tools === undefined ? "On through Pi's defaults; choosing any tool pins the list" : undefined}
                  onClick={() => {
                    const current = tools ?? [...PI_BUILTIN_TOOLS];
                    const next = current.includes(tool) ? current.filter((entry) => entry !== tool) : [...current, tool];
                    write({ defaultTools: next });
                  }}
                >
                  {tool}
                </button>
              );
            })}
          </div>
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Shell">
        <PiTextField
          label="Shell path"
          hint="A leading ~ is resolved; for a non-standard bash such as Cygwin"
          value={config.shellPath ?? ""}
          placeholder="system default"
          commit={(shellPath) => write({ shellPath })}
        />
        <PiTextField
          label="Command prefix"
          hint="Prepended to every bash command"
          value={config.shellCommandPrefix ?? ""}
          placeholder="none"
          commit={(shellCommandPrefix) => write({ shellCommandPrefix })}
        />
        <PiTextField
          label="npm command"
          hint="argv, space separated, for npm package operations"
          value={config.npmCommand?.join(" ") ?? ""}
          placeholder="npm"
          commit={(value) => write({ npmCommand: value.split(/\s+/u) })}
        />
      </SettingsSection>

      <SettingsSection title="Startup">
        <PiToggleRow
          label="Quiet startup"
          hint="Hide the header the Pi CLI prints on start."
          checked={config.quietStartup === true}
          onChange={(quietStartup) => write({ quietStartup })}
        />
        {scope === "global" ? (
          <SettingRow
            title="Project trust"
            description="What Pi does with a project's own settings, resources and extensions when nobody has answered for that folder. A global setting only."
            control={<div className="segmented" role="group" aria-label="Default project trust">
              {(["ask", "always", "never"] as const).map((mode) => (
                <button key={mode} className={(config.defaultProjectTrust ?? "ask") === mode ? "active" : ""} onClick={() => write({ defaultProjectTrust: mode })}>
                  {mode}
                </button>
              ))}
            </div>}
          />
        ) : null}
      </SettingsSection>
    </div>
  );
}
