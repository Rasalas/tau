import { useEffect, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import type { HostSnapshot, TauCompactionConfig, TauConfig, TauRetryConfig, UiModel } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";
import { READ_ONLY_REASON, useHostCapabilities } from "../use-host-capabilities";
import { errorMessage } from "../../workbench/error-message";
import { ModelPicker, modelKey } from "../components/ModelPicker";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { modelOnPlan } from "../runtime-marks";
import { tooltipProps } from "../components/ui/Tooltip";
import { Badge, NumberField, SegmentedControl, Select, SettingsState, Switch, TextField } from "./controls";
import { SettingRow, SettingsAdvanced, SettingsSection, useSetting } from "./settings-layout";
import { settingAnchor } from "./settings-search";

/**
 * Pi's own settings, the ones Pi reads from `~/.pi/agent/settings.json` and
 * applies itself. Tau mirrors them for reading and writes them back to that
 * file through `update-config`, so the workbench and the Pi CLI share one
 * configuration instead of Tau keeping a copy nothing acts on. The default
 * model and thinking sit on Pi's entry in Settings → Runtimes; the rest is
 * folded under Advanced.
 */
const PI_BUILTIN_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;

/** Pi's `defaultThinkingLevel` values (docs/settings.md). */
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LABELS: Record<(typeof PI_THINKING_LEVELS)[number], string> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};

type Delivery = "one-at-a-time" | "all";
const DELIVERY_OPTIONS = [{ value: "one-at-a-time", label: "One at a time" }, { value: "all", label: "All at once" }] as const;
type Trust = NonNullable<TauConfig["defaultProjectTrust"]>;
const TRUST_OPTIONS = [{ value: "ask", label: "Ask" }, { value: "always", label: "Always" }, { value: "never", label: "Never" }] as const;

const TRUST_REASON = "A global setting of Pi. Write Pi settings to All projects to change it.";

const readNumber = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined);

/** Why `text` is no model Pi's file can name. */
function modelProblem(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return "Enter a model, as provider/model-id.";
  if (/\s/u.test(trimmed)) return "A model id has no spaces.";
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return "Write it as provider/model-id.";
  return undefined;
}

/** The copy of `record` without `key`: what the file holds once a field is emptied. */
function without<T extends object>(record: T, key: keyof T): T {
  const next = { ...record };
  delete next[key];
  return next;
}

/** The default model: Pi's models in the picker when the host named them, else the id typed. */
function DefaultModel({ value, models, onChange }: { value: string; models: readonly UiModel[]; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (models.length === 0) {
    return <TextField label="Default model" value={value} mono placeholder="provider/model-id" validate={modelProblem} onCommit={(text) => onChange(text.trim())} />;
  }
  const chosen = value ? models.find((model) => modelKey(model) === value) : undefined;
  const shown = chosen?.name ?? (value || "Not set");
  return (
    <div className="settings-row-inline">
      <button ref={anchor} type="button" className="settings-model-button" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Default model: ${shown}`} onClick={() => setOpen((current) => !current)}
        {...tooltipProps(value || undefined, { when: "truncated" })}>
        {chosen ? <ProviderIconStack modelProvider={chosen.provider} plan={modelOnPlan(chosen)} className="chip-icon" hint={false} /> : <Sparkles size={14} className="accent" />}
        <span>{shown}</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open ? (
        <ModelPicker models={models} activeKey={value || undefined} onSelect={(model) => onChange(modelKey(model))} onClose={() => setOpen(false)} anchor={anchor} side="bottom" runtime="pi" />
      ) : null}
    </div>
  );
}

/** Pi's file as the page reads and writes it: loaded once, shared by the default rows and Advanced. */
export interface PiConfigHandle {
  /** Whether a machine is connected to read it from. */
  connected: boolean;
  config: TauConfig | undefined;
  loadError: string | undefined;
  reload(): void;
  write(patch: Partial<TauConfig>): void;
  scope: "global" | "project";
  setScope(scope: "global" | "project"): void;
}

export function usePiConfig(snapshot: HostSnapshot | undefined, onNotify: (message: string, level?: "info" | "warning" | "error") => void): PiConfigHandle {
  const client = useHostClient();
  // The opaque id is how a workspace is addressed; `cwd` is display data.
  const workspaceId = snapshot?.workspaceId ?? snapshot?.cwd;
  const [config, setConfig] = useState<TauConfig>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [scope, setScope] = useState<"global" | "project">("global");

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    client?.getConfig(workspaceId)
      .then((next) => { if (!cancelled) setConfig(next); })
      .catch((error: unknown) => { if (!cancelled) setLoadError(errorMessage(error)); });
    return () => { cancelled = true; };
  }, [client, workspaceId, attempt]);

  const write = (patch: Partial<TauConfig>) => {
    if (!client) return;
    client.updateConfig(patch, scope, workspaceId)
      .then((next) => setConfig(next))
      .catch((error: unknown) => onNotify(`Pi's settings were not written: ${errorMessage(error)}`, "error"));
  };
  return { connected: Boolean(client), config, loadError, reload: () => setAttempt((count) => count + 1), write, scope, setScope };
}

/** The rows of Pi's "Default model" section; nothing is drawn before the file has been read, so no control shows a default that is a guess. */
export function PiDefaults({ pi, snapshot }: { pi: PiConfigHandle; snapshot: HostSnapshot | undefined }) {
  const { config, write } = pi;
  // The host refuses a write from a device paired Read only; the rows say so instead.
  const { readOnly } = useHostCapabilities();
  const readOnlyReason = readOnly ? READ_ONLY_REASON : undefined;
  if (!pi.connected) {
    return <SettingsState kind="empty" title="No machine connected" description="Pi's settings live on the machine. Connect to one to read and change them." />;
  }
  if (!config) {
    return pi.loadError
      ? <SettingsState kind="error" title="Pi's settings did not load" description={pi.loadError} onRetry={pi.reload} />
      : <SettingsState kind="loading" title="Reading Pi's settings" rows={2} />;
  }
  const piModels = snapshot?.completionModels ?? (snapshot?.backendKind === "pi" ? snapshot.models : undefined) ?? [];
  const thinking = config.models?.thinkingLevel;
  return (
    <>
      <SettingRow
        id={settingAnchor("Default model")}
        title="Default model"
        description="What a new Pi thread starts on. A thread changes it in the composer."
        help="Pi's file stores it as provider/model-id."
        disabledReason={readOnlyReason}
        control={<DefaultModel value={config.models?.default ?? ""} models={piModels} onChange={(value) => write({ models: { ...config.models, default: value } })} />}
      />
      <SettingRow
        id={settingAnchor("Default thinking")}
        title="Default thinking"
        description="How much the model reasons before it answers."
        help="A model that does not think in levels ignores it. The composer's thinking chip sets it for one thread."
        disabledReason={readOnlyReason}
        control={<Select
          label="Default thinking"
          value={thinking}
          placeholder={thinking ? `${thinking} (unknown)` : "Pi's default"}
          options={PI_THINKING_LEVELS.map((level) => ({ value: level, label: THINKING_LABELS[level] }))}
          onChange={(value) => write({ models: { ...config.models, thinkingLevel: value } })}
        />}
      />
    </>
  );
}

/** What Pi samples with. Core's, so safe mode still has it. */
function Sampling() {
  const temperature = useSetting<number | undefined>("temperature", { defaultValue: undefined, scope: "both", read: readNumber, format: (value) => (value === undefined ? "Model default" : String(value)) });
  const maxTokens = useSetting<number | undefined>("maxTokens", { defaultValue: undefined, scope: "both", read: readNumber, format: (value) => (value === undefined ? "Model default" : String(value)) });
  return (
    <SettingsSection title="Sampling">
      <SettingRow
        id={settingAnchor("Temperature")}
        title="Temperature"
        description="How freely a Pi thread's model picks its words, from 0 to 2. Empty leaves it to the model."
        help="Other runtimes choose their own. OpenAI's reasoning models, and Claude while it thinks, take none."
        setting={temperature}
        control={<NumberField label="Temperature" value={temperature.value} step={0.1} min={0} max={2} placeholder="Model default" width="md" onCommit={temperature.set} onClear={temperature.reset} />}
      />
      <SettingRow
        id={settingAnchor("Max tokens")}
        title="Max tokens"
        description="The longest answer a Pi thread's model may give. Empty leaves it to the model."
        help="Other runtimes choose their own; the ChatGPT subscription's models take none."
        setting={maxTokens}
        control={<NumberField label="Max tokens" value={maxTokens.value} step={256} min={1} integer unit="tokens" placeholder="Model default" width="md" onCommit={maxTokens.set} onClear={maxTokens.reset} />}
      />
    </SettingsSection>
  );
}

/** Pi's expert values: where they are written, trust, compaction, retries, delivery, tools and sampling. */
export function PiAdvanced({ pi, snapshot }: { pi: PiConfigHandle; snapshot: HostSnapshot | undefined }) {
  const { config, write, scope } = pi;
  if (!config) return null;
  const compaction: TauCompactionConfig = config.compaction ?? {};
  const retry: TauRetryConfig = config.retry ?? {};
  const tools = config.defaultTools;

  return (
    <SettingsAdvanced id="pi-advanced" hint="Pi's own file, shared with the Pi CLI">
      <SettingsSection title="Projects">
        <SettingRow
          id={settingAnchor("Write Pi settings to")}
          title="Write Pi settings to"
          description={scope === "project"
            ? <>Changes go to <code>{snapshot?.cwd}/.pi/settings.json</code>.</>
            : <>Changes go to <code>~/.pi/agent/settings.json</code>.</>}
          help="A project's file overrides the global one for that project."
          control={<SegmentedControl<"global" | "project">
            label="Write Pi settings to"
            value={scope}
            options={[{ value: "global", label: "All projects" }, { value: "project", label: "This project", disabled: !snapshot?.cwd }]}
            onChange={pi.setScope}
          />}
        />
        <SettingRow
          id={settingAnchor("Project trust")}
          title="Project trust"
          description="What Pi does with a project's own settings, resources and extensions when nobody has answered for that folder."
          help="Always trusts them, Never ignores them, Ask asks in the Pi CLI and ignores them where it cannot ask."
          disabledReason={scope === "project" ? TRUST_REASON : undefined}
          control={<SegmentedControl<Trust> label="Project trust" value={config.defaultProjectTrust ?? "ask"} options={TRUST_OPTIONS} onChange={(defaultProjectTrust) => write({ defaultProjectTrust })} />}
        />
        <SettingRow
          id={settingAnchor("Quiet startup")}
          title="Quiet startup"
          description="Hide the header the Pi CLI prints on start."
          control={<Switch label="Quiet startup" checked={config.quietStartup === true} onChange={(quietStartup) => write({ quietStartup })} />}
        />
      </SettingsSection>

      <SettingsSection title="Compaction">
        <SettingRow
          id={settingAnchor("Automatic compaction")}
          title="Automatic compaction"
          description="Summarize the conversation when it nears the context window."
          control={<Switch label="Automatic compaction" checked={compaction.enabled !== false} onChange={(enabled) => write({ compaction: { ...compaction, enabled } })} />}
        />
        <SettingRow
          id={settingAnchor("Room for the reply")}
          title="Room for the reply"
          description="Held back for the model's reply (Pi's reserveTokens). Empty uses Pi's 16,384."
          control={<NumberField label="Room for the reply" value={compaction.reserveTokens} integer min={1} max={1_000_000} step={1024} unit="tokens" placeholder="16384" width="md"
            onCommit={(reserveTokens) => write({ compaction: { ...compaction, reserveTokens } })}
            onClear={() => write({ compaction: without(compaction, "reserveTokens") })} />}
        />
        <SettingRow
          id={settingAnchor("Keep recent")}
          title="Keep recent"
          description="The latest part of the conversation left unsummarized (Pi's keepRecentTokens). Empty uses Pi's 20,000."
          control={<NumberField label="Keep recent" value={compaction.keepRecentTokens} integer min={0} max={1_000_000} step={1000} unit="tokens" placeholder="20000" width="md"
            onCommit={(keepRecentTokens) => write({ compaction: { ...compaction, keepRecentTokens } })}
            onClear={() => write({ compaction: without(compaction, "keepRecentTokens") })} />}
        />
      </SettingsSection>

      <SettingsSection title="Retries">
        <SettingRow
          id={settingAnchor("Retry on transient errors")}
          title="Retry on transient errors"
          description="Pi tries a failed turn again, waiting longer each time."
          control={<Switch label="Retry on transient errors" checked={retry.enabled !== false} onChange={(enabled) => write({ retry: { ...retry, enabled } })} />}
        />
        <SettingRow
          id={settingAnchor("Retries")}
          title="Retries"
          description="Attempts after the first (Pi's maxRetries). Empty uses Pi's 3."
          control={<NumberField label="Retries" value={retry.maxRetries} integer min={0} max={20} placeholder="3" width="md"
            onCommit={(maxRetries) => write({ retry: { ...retry, maxRetries } })}
            onClear={() => write({ retry: without(retry, "maxRetries") })} />}
        />
        <SettingRow
          id={settingAnchor("First wait")}
          title="First wait"
          description="The wait before the first retry, doubled for each one after (Pi's baseDelayMs). Empty uses Pi's 2,000 ms."
          control={<NumberField label="First wait" value={retry.baseDelayMs} integer min={0} max={60_000} step={500} unit="ms" placeholder="2000" width="md"
            onCommit={(baseDelayMs) => write({ retry: { ...retry, baseDelayMs } })}
            onClear={() => write({ retry: without(retry, "baseDelayMs") })} />}
        />
      </SettingsSection>

      <SettingsSection title="Message delivery">
        <SettingRow
          id={settingAnchor("Steering messages")}
          title="Steering messages"
          description="Sent while the agent is working."
          control={<SegmentedControl<Delivery> label="Steering messages" value={config.steeringMode ?? "one-at-a-time"} options={DELIVERY_OPTIONS} onChange={(steeringMode) => write({ steeringMode })} />}
        />
        <SettingRow
          id={settingAnchor("Follow-up messages")}
          title="Follow-up messages"
          description="Queued behind the current turn."
          control={<SegmentedControl<Delivery> label="Follow-up messages" value={config.followUpMode ?? "one-at-a-time"} options={DELIVERY_OPTIONS} onChange={(followUpMode) => write({ followUpMode })} />}
        />
      </SettingsSection>

      <SettingsSection title="Tools and shell">
        <SettingRow
          id={settingAnchor("Built-in tools")}
          title="Built-in tools"
          description={tools === undefined
            ? "Pi's standard set is in use. Changing one pins the list."
            : "The list is pinned. With none chosen, every built-in tool is off."}
          help="Extension and SDK tools stay on whatever this list holds. Pi allows an empty list on purpose."
          status={tools === undefined ? <Badge>Pi's standard set</Badge> : <Badge tone="accent">Pinned</Badge>}
        >
          <div className="pi-tools" role="group" aria-label="Built-in tools">
            {PI_BUILTIN_TOOLS.map((tool) => (
              <label key={tool}>
                <Switch
                  role="checkbox"
                  label={tool}
                  checked={tools === undefined || tools.includes(tool)}
                  onChange={(on) => {
                    const current = tools ?? [...PI_BUILTIN_TOOLS];
                    write({ defaultTools: on ? [...current, tool] : current.filter((entry) => entry !== tool) });
                  }}
                />
                <code aria-hidden>{tool}</code>
              </label>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          id={settingAnchor("Shell path")}
          title="Shell path"
          description="For a bash outside the usual places, such as Cygwin. Empty uses the system's."
          help="A leading ~ stands for the home folder."
          control={<TextField label="Shell path" value={config.shellPath ?? ""} mono placeholder="System default" onCommit={(value) => write({ shellPath: value.trim() })} />}
        />
        <SettingRow
          id={settingAnchor("Command prefix")}
          title="Command prefix"
          description="Run before every bash command, on its own line."
          control={<TextField label="Command prefix" value={config.shellCommandPrefix ?? ""} mono placeholder="None" onCommit={(value) => write({ shellCommandPrefix: value.trim() })} />}
        />
        <SettingRow
          id={settingAnchor("npm command")}
          title="npm command"
          description="The command Pi installs and looks up packages with, its words separated by spaces."
          help="For example mise exec node@20 -- npm."
          control={<TextField label="npm command" value={config.npmCommand?.join(" ") ?? ""} mono placeholder="npm"
            validate={(value) => (value.trim() ? undefined : "Enter a command, such as npm.")}
            onCommit={(value) => write({ npmCommand: value.trim().split(/\s+/u) })} />}
        />
      </SettingsSection>

      <Sampling />
    </SettingsAdvanced>
  );
}
