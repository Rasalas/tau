import { useEffect, useState, useSyncExternalStore } from "react";
import { ChevronDown, Plus, Sparkles } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import { TRANSCRIPT_DETAIL_LEVELS, isTranscriptDetail, type TranscriptDetail } from "../../workbench/transcript-folding";
import { allAvailableThemes, getUserTheme } from "../theme";
import { usePreferences } from "../renderer-services-context";
import { effectiveNewThreadRuntime } from "../new-thread-runtime";
import { ModelPicker, modelKey } from "../components/ModelPicker";
import { AddModelProviderModal } from "../components/AddModelProviderModal";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { runtimeUpdate } from "../runtime-update";
import type { SendShortcut } from "../components/composer-send-keys";
import { CONFIG_DEFAULTS } from "../../shared/config-layers";
import { SettingRow, SettingsSection, useSetting } from "./settings-layout";
import { settingAnchor } from "./settings-search";

const SEND_SHORTCUT_LABELS: ReadonlyArray<readonly [SendShortcut, string]> = [
  ["enter", "↵"],
  ["mod-enter-multiline", "⌘↵ for several lines"],
  ["mod-enter", "⌘↵"],
];

const DETAIL_LABELS: Record<TranscriptDetail, string> = { focused: "Focused", detailed: "Detailed", everything: "Everything" };

const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);
const readNumber = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined);

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange(next: boolean): void }) {
  return (
    <button className={`switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

/** A number that is written when focus leaves the field, and cleared when it is emptied. */
function NumberField({ label, value, step, min, max, onCommit, onClear }: {
  label: string;
  value?: number;
  step: number;
  min?: number;
  max?: number;
  onCommit(value: number): void;
  onClear(): void;
}) {
  const [draft, setDraft] = useState(value !== undefined ? String(value) : "");
  useEffect(() => setDraft(value !== undefined ? String(value) : ""), [value]);
  const commit = () => {
    const text = draft.trim();
    if (!text) { if (value !== undefined) onClear(); return; }
    const parsed = Number(text);
    if (Number.isFinite(parsed) && parsed !== value) onCommit(parsed);
  };
  return (
    <input
      type="number"
      className="settings-input narrow"
      aria-label={label}
      placeholder="Default"
      step={step}
      min={min}
      max={max}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === "Enter") commit(); }}
    />
  );
}

/** The seed of a new thread and the workbench's own behaviour; core's, so safe mode has it. */
export function DefaultsPage({
  snapshot,
  onSetModel,
  onSetThinking,
}: {
  snapshot?: HostSnapshot;
  onSetModel(provider: string, id: string): void;
  onSetThinking(level: string): void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const preferences = usePreferences();
  const { newThreadRuntime: runtimePreference, sendShortcut } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const newThreadRuntime = effectiveNewThreadRuntime(runtimePreference, snapshot);

  const detail = useSetting<TranscriptDetail>("transcriptDetail", {
    defaultValue: CONFIG_DEFAULTS.transcriptDetail as TranscriptDetail, scope: "both", read: (raw) => (isTranscriptDetail(raw) ? raw : undefined),
    format: (value) => DETAIL_LABELS[value], offline: (value) => preferences.setTranscriptDetail(value),
  });
  const theme = useSetting<string>("theme", {
    defaultValue: CONFIG_DEFAULTS.theme as string, read: (raw) => (typeof raw === "string" && raw ? raw : undefined),
    format: (value) => getUserTheme(value)?.name ?? value, offline: (value) => preferences.setTheme(value),
  });
  const showCosts = useSetting<boolean>("showCosts", { defaultValue: CONFIG_DEFAULTS.showCosts as boolean, scope: "both", read: readBoolean, offline: (value) => preferences.setShowCosts(value) });
  const vimMode = useSetting<boolean>("vimMode", {
    defaultValue: CONFIG_DEFAULTS.vimMode as boolean, read: readBoolean, format: (value) => (value ? "Vim" : "Standard"), offline: (value) => preferences.setVimMode(value),
  });
  const hostBackground = useSetting<boolean>("hostBackground", { defaultValue: CONFIG_DEFAULTS.hostBackground as boolean, read: readBoolean, offline: (value) => preferences.setHostBackground(value) });
  const continueAfterRestart = useSetting<boolean>("threads.continueAfterRestart", {
    defaultValue: CONFIG_DEFAULTS["threads.continueAfterRestart"] as boolean, read: readBoolean, offline: (value) => preferences.setContinueThreadsAfterRestart(value),
  });
  const temperature = useSetting<number | undefined>("temperature", { defaultValue: undefined, scope: "both", read: readNumber, format: (value) => (value === undefined ? "Model default" : String(value)) });
  const maxTokens = useSetting<number | undefined>("maxTokens", { defaultValue: undefined, scope: "both", read: readNumber, format: (value) => (value === undefined ? "Model default" : String(value)) });

  return (
    <>
      <SettingsSection title="New threads">
        <SettingRow
          id={settingAnchor("Default model")}
          title="Model"
          description={`What a new thread starts on, from Pi's configuration in ~/.pi/agent${snapshot?.model?.login === "subscription" ? " (a subscription login)" : ""}. The composer changes it per thread.`}
          control={<div className="settings-row-inline">
            <button className="settings-field compact" onClick={() => setPickerOpen(true)}>
              {snapshot?.model
                ? <ProviderIconStack modelProvider={snapshot.model.provider} runtimeProvider={snapshot.backendKind} className="chip-icon" />
                : <Sparkles size={14} className="accent" />}
              <span>
                <strong>{snapshot?.model?.name ?? "No model selected"}</strong>
                <small>{snapshot?.model?.provider ?? "pi"}</small>
              </span>
              <b><ChevronDown size={13} /></b>
            </button>
            <button className="icon-button bordered" onClick={() => setAddProviderOpen(true)} title="Add custom model provider" aria-label="Add custom model provider">
              <Plus size={14} />
            </button>
          </div>}
        />
        <SettingRow
          id={settingAnchor("Thinking level")}
          title="Thinking"
          description="How much the model reasons before it answers. Shift-Tab cycles it in the composer."
          control={(snapshot?.thinkingLevels ?? []).length > 0 ? <div className="segmented">
            {(snapshot?.thinkingLevels ?? []).map((level) => (
              <button key={level} className={level === snapshot?.thinkingLevel ? "active" : ""} onClick={() => onSetThinking(level)}>{level}</button>
            ))}
          </div> : <span className="settings-row-empty">The model has no thinking levels</span>}
        />
        {(snapshot?.runtimeBackends?.length ?? 0) > 1 ? (
          <SettingRow
            id={settingAnchor("Runtime for new threads")}
            title="Runtime"
            description="Which program runs a new thread. Threads that exist keep theirs; the composer offers the same choice before the first message."
            status={(snapshot?.runtimeBackends ?? []).map((backend) => {
              const update = runtimeUpdate(backend);
              return update ? <p key={backend.kind} role="status">{update.text}{update.command ? <> Update with <code>{update.command}</code>.</> : null}</p> : null;
            })}
            control={<div className="segmented" role="group" aria-label="Runtime for new threads">
              {(snapshot?.runtimeBackends ?? []).map((backend) => (
                <button key={backend.kind} className={backend.kind === newThreadRuntime ? "active" : ""} aria-pressed={backend.kind === newThreadRuntime} onClick={() => preferences.setNewThreadRuntime(backend.kind)}>
                  {backend.label}
                </button>
              ))}
            </div>}
          />
        ) : null}
        <SettingRow
          id={settingAnchor("Model parameters")}
          title="Temperature"
          description="Sampling temperature for generations; empty leaves it to the model."
          setting={temperature}
          control={<NumberField label="Temperature" value={temperature.value} step={0.1} min={0} max={2} onCommit={temperature.set} onClear={temperature.reset} />}
        />
        <SettingRow
          title="Max tokens"
          description="The longest answer a generation may give; empty leaves it to the model."
          setting={maxTokens}
          control={<NumberField label="Max tokens" value={maxTokens.value} step={256} min={1} onCommit={maxTokens.set} onClear={maxTokens.reset} />}
        />
      </SettingsSection>

      <SettingsSection title="Conversation">
        <SettingRow
          id={settingAnchor("Transcript detail")}
          title="Transcript detail"
          description="Focused reads a settled turn as one line; detailed opens every group and shows thinking; everything adds full tool output and timestamps. ⇧⌘T cycles them for the thread on screen."
          setting={detail}
          control={<div className="segmented" role="group" aria-label="Transcript detail">
            {TRANSCRIPT_DETAIL_LEVELS.map((level) => (
              <button key={level} className={level === detail.value ? "active" : ""} aria-pressed={level === detail.value} onClick={() => detail.set(level)}>{DETAIL_LABELS[level]}</button>
            ))}
          </div>}
        />
        <SettingRow
          id={settingAnchor("Show costs")}
          title="Show costs"
          description="What each thread has spent, in the composer and the thread list."
          setting={showCosts}
          control={<Switch label="Show costs" checked={showCosts.value} onChange={showCosts.set} />}
        />
        <SettingRow
          id={settingAnchor("Composer editing mode")}
          title="Composer editing mode"
          description="Standard has Readline and Emacs shortcuts; Vim edits the composer with Normal and Insert modes."
          setting={vimMode}
          control={<div className="segmented" role="group" aria-label="Composer editing mode">
            <button className={!vimMode.value ? "active" : ""} aria-pressed={!vimMode.value} onClick={() => vimMode.set(false)}>Standard</button>
            <button className={vimMode.value ? "active" : ""} aria-pressed={vimMode.value} onClick={() => vimMode.set(true)}>Vim</button>
          </div>}
        />
        <SettingRow
          id={settingAnchor("Send with")}
          title="Send with"
          description="While a turn runs the send chord queues a follow-up and ⌘↵ steers the turn (⌘⇧↵ when ⌘↵ sends). This window's own choice."
          control={<div className="segmented" role="group" aria-label="Send with">
            {SEND_SHORTCUT_LABELS.map(([value, label]) => (
              <button key={value} className={value === sendShortcut ? "active" : ""} aria-pressed={value === sendShortcut} onClick={() => preferences.setSendShortcut(value)}>{label}</button>
            ))}
          </div>}
        />
      </SettingsSection>

      <SettingsSection title="Appearance">
        <SettingRow
          id={settingAnchor("Theme")}
          title="Theme"
          description={<>System follows this machine's light or dark setting. Themes are <code>.css</code> or <code>.json</code> files in <code>~/.tau/themes/</code>.</>}
          setting={theme}
          control={<div className="segmented" role="group" aria-label="Theme">
            {allAvailableThemes().map((preference) => (
              <button key={preference} className={preference === theme.value ? "active" : ""} aria-pressed={preference === theme.value} onClick={() => theme.set(preference)}>
                {getUserTheme(preference)?.name ?? preference}
              </button>
            ))}
          </div>}
        />
      </SettingsSection>

      <SettingsSection title="Host">
        <SettingRow
          id={settingAnchor("Keep the host running in the background")}
          title="Keep the host running in the background"
          description="Threads keep working after you quit Tau, and the next start picks them up again."
          setting={hostBackground}
          control={<Switch label="Keep the host running in the background" checked={hostBackground.value} onChange={hostBackground.set} />}
        />
        <SettingRow
          id={settingAnchor("Continue threads after restarts")}
          title="Continue threads after restarts"
          description="Pick a thread back up where a restart cut its turn short. Off, the thread is repaired and marked instead."
          setting={continueAfterRestart}
          control={<Switch label="Continue threads after restarts" checked={continueAfterRestart.value} onChange={continueAfterRestart.set} />}
        />
      </SettingsSection>

      {pickerOpen ? (
        <ModelPicker
          models={snapshot?.models ?? []}
          activeKey={snapshot?.model ? modelKey(snapshot.model) : undefined}
          onSelect={(model) => onSetModel(model.provider, model.id)}
          onClose={() => setPickerOpen(false)}
          runtime={snapshot?.backendKind}
        />
      ) : null}
      {addProviderOpen ? <AddModelProviderModal onClose={() => setAddProviderOpen(false)} /> : null}
    </>
  );
}
