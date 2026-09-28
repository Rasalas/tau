import { useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Plus, Sparkles } from "lucide-react";
import type { HostSnapshot } from "../../shared/contracts";
import { usePreferences } from "../renderer-services-context";
import { effectiveNewThreadRuntime } from "../new-thread-runtime";
import { ModelPicker, modelKey } from "../components/ModelPicker";
import { AddModelProviderModal } from "../components/AddModelProviderModal";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { DEFAULT_RUNTIME, modelOnPlan } from "../runtime-marks";
import { tooltipProps } from "../components/ui/Tooltip";
import { READ_ONLY_REASON, useHostCapabilities } from "../use-host-capabilities";
import { Button, NumberField, Select } from "./controls";
import { SettingRow, SettingsSection, useSetting } from "./settings-layout";
import { settingAnchor } from "./settings-search";

const readNumber = (raw: unknown) => (typeof raw === "number" && Number.isFinite(raw) ? raw : undefined);
const THINKING_LABELS: Record<string, string> = { off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/**
 * Settings → Models: what a new thread starts with — its model, how much it
 * thinks and the sampling Pi sends. Core's, so safe mode still has a model
 * picker. The runtime a new thread starts on is chosen on Runtimes.
 */
export function ModelsPage({ snapshot, providersHere, onSetModel, onSetThinking, onOpen }: {
  snapshot?: HostSnapshot;
  /** Whether this client has the Providers page to send the user to. */
  providersHere: boolean;
  onSetModel(provider: string, id: string): void;
  onSetThinking(level: string): void;
  /** Opens another place in Settings. */
  onOpen(target: string): void;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerAnchor = useRef<HTMLButtonElement>(null);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const preferences = usePreferences();
  const { newThreadRuntime: runtimePreference } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const newThreadRuntime = effectiveNewThreadRuntime(runtimePreference, snapshot);
  // Model and thinking are the host's; a Read-only device starts no thread to pick them for.
  const { readOnly } = useHostCapabilities();
  const threadDefaults = readOnly ? READ_ONLY_REASON : undefined;
  const temperature = useSetting<number | undefined>("temperature", { defaultValue: undefined, scope: "both", read: readNumber, format: (value) => (value === undefined ? "Model default" : String(value)) });
  const maxTokens = useSetting<number | undefined>("maxTokens", { defaultValue: undefined, scope: "both", read: readNumber, format: (value) => (value === undefined ? "Model default" : String(value)) });
  const levels = snapshot?.thinkingLevels ?? [];
  const newThreadLabel = snapshot?.runtimeBackends?.find((backend) => backend.kind === newThreadRuntime)?.label ?? "Pi";

  return (
    <div className="settings-page">
      <SettingsSection title="New threads">
        <SettingRow
          id={settingAnchor("Default model")}
          title="Model"
          description={`What a new thread starts on${snapshot?.model?.login === "subscription" ? ", through a subscription login" : ""}. The composer changes it per thread.`}
          disabledReason={threadDefaults}
          control={<div className="settings-row-inline">
            <button ref={pickerAnchor} type="button" className="settings-model-button" aria-haspopup="dialog" aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)}
              {...tooltipProps(snapshot?.model ? `${snapshot.model.name} · ${snapshot.model.provider}` : undefined, { when: "truncated" })}>
              {snapshot?.model
                ? <ProviderIconStack modelProvider={snapshot.model.provider} runtimeProvider={snapshot.backendKind ?? DEFAULT_RUNTIME} plan={modelOnPlan(snapshot.model)} className="chip-icon" hint={false} />
                : <Sparkles size={14} className="accent" />}
              <span>{snapshot?.model?.name ?? "No model selected"}</span>
              <ChevronDown size={14} aria-hidden />
            </button>
            <button type="button" className="tau-icon-button settings-model-add" onClick={() => setAddProviderOpen(true)} aria-label="Add custom model provider" {...tooltipProps("Add custom model provider")}>
              <Plus size={15} />
            </button>
          </div>}
        />
        <SettingRow
          id={settingAnchor("Thinking level")}
          title="Thinking"
          description="How much the model reasons before it answers. Shift-Tab cycles it in the composer."
          disabledReason={threadDefaults}
          control={levels.length > 0
            ? <Select label="Thinking" value={snapshot?.thinkingLevel} options={levels.map((level) => ({ value: level, label: THINKING_LABELS[level] ?? level }))} onChange={onSetThinking} />
            : <span className="settings-row-empty">This model does not think in levels</span>}
        />
      </SettingsSection>

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

      <SettingsSection title="Where models come from">
        <SettingRow
          title="Runtimes"
          description={`The programs that run threads: new ones start on ${newThreadLabel}. Their versions, updates and permissions.`}
          control={<Button onClick={() => onOpen("runtimes")}>Open Runtimes</Button>}
        />
        {providersHere ? (
          <SettingRow
            title="Providers and sign-ins"
            description="Who each runtime is signed in as, and the models it offers."
            control={<Button onClick={() => onOpen("providers")}>Open Providers</Button>}
          />
        ) : null}
      </SettingsSection>

      {pickerOpen ? (
        <ModelPicker
          models={snapshot?.models ?? []}
          activeKey={snapshot?.model ? modelKey(snapshot.model) : undefined}
          onSelect={(model) => onSetModel(model.provider, model.id)}
          onClose={() => setPickerOpen(false)}
          anchor={pickerAnchor}
          side="bottom"
          runtime={snapshot?.backendKind}
        />
      ) : null}
      {addProviderOpen ? <AddModelProviderModal onClose={() => setAddProviderOpen(false)} /> : null}
    </div>
  );
}
