import { useEffect, useId, useState } from "react";
import type { HostSnapshot, TauConfig } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";

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
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  useEffect(() => { setDraft(value); }, [value]);
  const send = () => { if (draft.trim() && draft.trim() !== value.trim()) commit(draft.trim()); };
  return (
    <div className="settings-field-row">
      <span className="settings-field-label">
        <label htmlFor={fieldId}><strong>{label}</strong></label>
        {hint ? <small id={hintId}>{hint}</small> : null}
      </span>
      <input
        id={fieldId}
        aria-describedby={hint ? hintId : undefined}
        type="text"
        className="settings-search-input"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={send}
        onKeyDown={(event) => { if (event.key === "Enter") send(); }}
      />
    </div>
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
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  useEffect(() => { setDraft(value !== undefined ? String(value) : ""); }, [value]);
  const send = () => {
    const parsed = Number.parseInt(draft, 10);
    if (Number.isFinite(parsed) && parsed !== value) commit(parsed);
  };
  return (
    <div className="settings-field-row">
      <span className="settings-field-label">
        <label htmlFor={fieldId}><strong>{label}</strong></label>
        {hint ? <small id={hintId}>{hint}</small> : null}
      </span>
      <input
        id={fieldId}
        aria-describedby={hint ? hintId : undefined}
        type="number"
        className="settings-search-input"
        style={{ width: "140px" }}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={send}
        onKeyDown={(event) => { if (event.key === "Enter") send(); }}
      />
    </div>
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
    <div className="settings-toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
      <button
        className={`switch ${checked ? "on" : ""}`}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <i />
      </button>
    </div>
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

  return (
    <div className="settings-page">
      <h3>Pi</h3>
      <p className="lede">
        Pi's own settings, in <code>~/.pi/agent/settings.json</code> and <code>&lt;project&gt;/.pi/settings.json</code>.
        Tau reads and writes that file, so the Pi CLI sees the same configuration. A change applies to the next
        runtime Tau builds; a thread that is already running keeps what it started with.
      </p>

      <div className="settings-label">WRITE TO</div>
      <div className="segmented" role="group" aria-label="Settings scope">
        <button className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}>All projects</button>
        <button
          className={scope === "project" ? "active" : ""}
          aria-pressed={scope === "project"}
          disabled={!snapshot?.cwd}
          onClick={() => setScope("project")}
        >
          This project
        </button>
      </div>
      <p className="settings-note">
        {scope === "project"
          ? <>Writes to <code>{snapshot?.cwd}/.pi/settings.json</code>.</>
          : <>Writes to <code>~/.pi/agent/settings.json</code>.</>}
      </p>

      <div className="settings-label">STARTUP MODEL</div>
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

      <div className="settings-label">COMPACTION</div>
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

      <div className="settings-label">RETRY</div>
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

      <div className="settings-label">MESSAGE DELIVERY</div>
      <div className="settings-field-row">
        <span className="settings-field-label"><strong>Steering messages</strong><small>Sent while the agent is running</small></span>
        <div className="segmented" role="group" aria-label="Steering messages">
          {(["one-at-a-time", "all"] as const).map((mode) => (
            <button
              key={mode}
              className={(config.steeringMode ?? "one-at-a-time") === mode ? "active" : ""}
              onClick={() => write({ steeringMode: mode })}
            >
              {mode === "all" ? "All at once" : "One at a time"}
            </button>
          ))}
        </div>
      </div>
      <div className="settings-field-row">
        <span className="settings-field-label"><strong>Follow-up messages</strong><small>Queued behind the current turn</small></span>
        <div className="segmented" role="group" aria-label="Follow-up messages">
          {(["one-at-a-time", "all"] as const).map((mode) => (
            <button
              key={mode}
              className={(config.followUpMode ?? "one-at-a-time") === mode ? "active" : ""}
              onClick={() => write({ followUpMode: mode })}
            >
              {mode === "all" ? "All at once" : "One at a time"}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-label">BUILT-IN TOOLS</div>
      <p className="settings-note">
        {tools === undefined
          ? "Pi's standard set is in use. Choosing any of them pins the list; choosing none turns every built-in tool off, which Pi allows on purpose. Extension and SDK tools are not affected."
          : "This list is pinned. Choosing none turns every built-in tool off. Extension and SDK tools are not affected."}
      </p>
      <div className="chip-row">
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

      <div className="settings-label">SHELL</div>
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

      <div className="settings-label">STARTUP</div>
      <PiToggleRow
        label="Quiet startup"
        hint="Hide the header the Pi CLI prints on start."
        checked={config.quietStartup === true}
        onChange={(quietStartup) => write({ quietStartup })}
      />

      {scope === "global" ? (
        <>
          <div className="settings-label">PROJECT TRUST</div>
          <div className="segmented" role="group" aria-label="Default project trust">
            {(["ask", "always", "never"] as const).map((mode) => (
              <button
                key={mode}
                className={(config.defaultProjectTrust ?? "ask") === mode ? "active" : ""}
                onClick={() => write({ defaultProjectTrust: mode })}
              >
                {mode}
              </button>
            ))}
          </div>
          <p className="settings-note">
            What Pi does with a project's own settings, resources and extensions when nobody has answered for that
            folder. A global setting only.
          </p>
        </>
      ) : null}
    </div>
  );
}
