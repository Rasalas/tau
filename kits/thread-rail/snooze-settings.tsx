import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Plus, Trash2 } from "lucide-react";
import { SettingRow, SettingsState, Select, READ_ONLY_REASON, errorMessage, tooltipProps, useHostCapabilities, type SettingsSectionProps } from "tau";
import { DEFAULT_SNOOZE_PRESETS, decodeSnoozePresets, snoozePresets } from "./meta.js";
import type { RailSettings, SnoozePreset } from "./protocol.js";
import type { RailStore } from "./store.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayOptions = [{ value: "today", label: "Today" }, { value: "tomorrow", label: "Tomorrow" }, ...[1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: DAYS[day]! }))];
const MAX = { minutes: 43200, hours: 720, days: 30 };

function Duration({ preset, disabled, change }: { preset: Extract<SnoozePreset, { kind: "after" }>; disabled: boolean; change(preset: SnoozePreset): void }) {
  const [text, setText] = useState(String(preset.amount));
  const [error, setError] = useState(false);
  useEffect(() => { setText(String(preset.amount)); setError(false); }, [preset.amount]);
  const commit = () => {
    const amount = Number(text);
    if (!decodeSnoozePresets([{ ...preset, amount }])) { setError(true); return; }
    setError(false);
    if (amount !== preset.amount) change({ ...preset, amount });
  };
  return <>
    <label>After<input type="number" aria-label="Duration" min={1} max={MAX[preset.unit]} step={1} value={text} disabled={disabled} aria-invalid={error || undefined}
      onChange={(event) => setText(event.target.value)} onBlur={() => { if (!disabled) commit(); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} /></label>
    <Select label="Unit" value={preset.unit} disabled={disabled} options={["minutes", "hours", "days"].map((unit) => ({ value: unit, label: unit }))}
      onChange={(unit) => { const next = { ...preset, unit: unit as typeof preset.unit }; change({ ...next, amount: Math.min(next.amount, MAX[next.unit]) }); }} />
    {error ? <small role="alert">Use a whole number from 1 to {MAX[preset.unit]} {preset.unit}.</small> : null}
  </>;
}

/** Host-backed rather than device preferences: compact edits the same list. */
export function createSnoozeRows(store: RailStore, update: (settings: Partial<RailSettings>) => Promise<void>) {
  return function SnoozeRows({ onNotify }: SettingsSectionProps) {
    const version = useSyncExternalStore(store.subscribe, store.getVersion);
    const source = store.getState().settings.snoozePresets ?? DEFAULT_SNOOZE_PRESETS;
    const [presets, setPresets] = useState(source);
    const [failure, setFailure] = useState<{ message: string; presets: readonly SnoozePreset[] }>();
    const [showLoading, setShowLoading] = useState(false);
    const pending = useRef(0);
    const writes = useRef(Promise.resolve());
    const [now, setNow] = useState(() => new Date());
    const { readOnly } = useHostCapabilities();
    useEffect(() => {
      if (store.loaded) return;
      const timer = setTimeout(() => setShowLoading(true), 300);
      return () => clearTimeout(timer);
    }, [store.loaded]);
    useEffect(() => { if (!pending.current) setPresets(source); }, [source, version]);
    useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(timer); }, []);
    const save = (next: readonly SnoozePreset[]) => {
      if (readOnly || !store.loaded) return;
      setFailure(undefined);
      setPresets(next);
      pending.current += 1;
      writes.current = writes.current.then(() => update({ snoozePresets: next })).catch((error: unknown) => { setFailure({ message: errorMessage(error), presets: next }); onNotify(errorMessage(error), "error"); }).finally(() => {
        pending.current -= 1;
        if (!pending.current) setPresets(store.getState().settings.snoozePresets ?? DEFAULT_SNOOZE_PRESETS);
      });
    };
    const change = (index: number, next: SnoozePreset) => save(presets.map((preset, at) => at === index ? next : preset));
    if (!store.loaded) return showLoading ? <SettingsState kind="loading" title="Loading snooze options" /> : null;
    return <SettingRow id="setting-thread-rail-snooze" title="Snooze options" description="Saved on this machine and used on every device that shows it." disabledReason={readOnly ? READ_ONLY_REASON : undefined}>
      <div className="thread-rail-snooze-options">
        {failure ? <SettingsState kind="error" title="Couldn't save snooze options." description={failure.message} action={<button type="button" disabled={readOnly} onClick={() => save(failure.presets)}>Retry</button>} /> : null}
        {presets.map((preset, index) => <div key={preset.id} className="thread-rail-snooze-option" role="group" aria-label={`Snooze option ${index + 1}`}>
          <Select label="Kind" value={preset.kind} disabled={readOnly} options={[{ value: "after", label: "After" }, { value: "at", label: "At" }]}
            onChange={(kind) => change(index, kind === "after" ? { id: preset.id, kind, amount: 1, unit: "hours" } : { id: preset.id, kind: "at", day: "tomorrow", time: "09:00" })} />
          {preset.kind === "after" ? <Duration preset={preset} disabled={readOnly} change={(next) => change(index, next)} /> : <>
            <Select label="Day" value={String(preset.day)} disabled={readOnly} options={dayOptions}
              onChange={(day) => change(index, { ...preset, day: day === "today" || day === "tomorrow" ? day : Number(day) })} />
            <label>Time<input type="time" aria-label="Time" disabled={readOnly} defaultValue={preset.time} key={preset.time} onBlur={(event) => {
              const next = { ...preset, time: event.target.value };
              if (decodeSnoozePresets([next])) change(index, next);
              else event.target.value = preset.time;
            }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} /></label>
          </>}
          <button type="button" className="icon-button" aria-label={`Remove snooze option ${index + 1}`} disabled={readOnly || presets.length === 1}
            {...tooltipProps(presets.length === 1 ? "Keep at least one option." : "Remove")}
            onClick={() => save(presets.filter((_, at) => at !== index))}><Trash2 size={14} /></button>
        </div>)}
        <div className="thread-rail-snooze-buttons">
          <button type="button" className="chrome-button" disabled={readOnly || presets.length === 8} {...tooltipProps(presets.length === 8 ? "Up to 8 options." : "Add option")}
            onClick={() => save([...presets, { id: `option-${crypto.randomUUID().slice(0, 8)}`, kind: "after", amount: 1, unit: "hours" }])}><Plus size={13} />Add option</button>
          <button type="button" className="text-button" disabled={readOnly} onClick={() => save(DEFAULT_SNOOZE_PRESETS)}>Reset to defaults</button>
        </div>
        <p className="setting-description">Right now the menu shows: {snoozePresets(now, { snoozePresets: presets }).map((preset) => `${preset.label} (${new Date(preset.until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})`).join(" · ")}</p>
      </div>
    </SettingRow>;
  };
}
