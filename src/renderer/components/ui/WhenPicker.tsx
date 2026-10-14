import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, Check, ChevronRight } from "lucide-react";
import { useClientStorage } from "../../client-storage-context";
import { isImeComposing } from "../../keybindings";
import { CUSTOM_WHEN, localDateTimeInput, readWhenPick, type WhenPick, type WhenPreset } from "../when-pick";
import "./when-picker.css";

/**
 * A list of times, as Snooze and Plan show it (API 1.64.0): the presets, then
 * a date and time of the user's own. It opens on the pick saved under
 * `rememberKey` (`rememberWhenPick`) when that row is still offered. ↑↓ move,
 * Enter confirms; a double click confirms a row.
 */
export function WhenPicker({ presets, rememberKey, label, now = Date.now, autoFocus = false, onChange, onConfirm }: {
  presets: readonly WhenPreset[];
  rememberKey?: string;
  label: string;
  now?(): number;
  /** The list takes focus when it appears, as a dialog's first field. */
  autoFocus?: boolean;
  /** The time picked and its row; `at` is undefined while a date of the user's own is not in the future. */
  onChange(at: number | undefined, pick: WhenPick): void;
  onConfirm?(): void;
}) {
  const storage = useClientStorage();
  const [pick, setPick] = useState<WhenPick>(() => {
    const remembered = rememberKey ? readWhenPick(storage, rememberKey) : undefined;
    if (remembered === CUSTOM_WHEN || presets.some((preset) => preset.id === remembered)) return remembered!;
    return presets[0]?.id ?? CUSTOM_WHEN;
  });
  const [custom, setCustom] = useState(() => localDateTimeInput(presets.find((preset) => preset.id === "tomorrow")?.at ?? now() + 3_600_000));
  const customField = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const rows = [...presets.map((preset) => preset.id), CUSTOM_WHEN];
  const at = pick === CUSTOM_WHEN
    ? (() => { const value = new Date(custom).getTime(); return Number.isFinite(value) && value > now() ? value : undefined; })()
    : presets.find((preset) => preset.id === pick)?.at;
  // Before the dialog's own effect, which then leaves the focus here; React's autoFocus skips a div.
  useLayoutEffect(() => { if (autoFocus) list.current?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => { onChangeRef.current(at, pick); }, [at, pick]);

  const move = (step: number) => {
    const index = rows.indexOf(pick);
    setPick(rows[Math.max(0, Math.min(rows.length - 1, index + step))]!);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isImeComposing(event.nativeEvent)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
    else if (event.key === "Home" || event.key === "End") { event.preventDefault(); setPick(rows[event.key === "Home" ? 0 : rows.length - 1]!); }
    else if (event.key === "Enter") {
      event.preventDefault();
      if (pick === CUSTOM_WHEN) customField.current?.focus();
      else onConfirm?.();
    }
  };
  return (
    <div className="when-picker">
      <div ref={list} className="when-picker-list" role="listbox" aria-label={label} tabIndex={0} aria-activedescendant={`${id}-${pick}`} onKeyDown={onKeyDown}>
        {presets.map((preset) => (
          <div
            key={preset.id}
            id={`${id}-${preset.id}`}
            role="option"
            aria-selected={pick === preset.id}
            className="when-picker-row"
            onClick={() => { setPick(preset.id); list.current?.focus(); }}
            onDoubleClick={() => onConfirm?.()}
          >
            <Check size={14} className="when-picker-tick" aria-hidden="true" />
            <span>{preset.label}</span>
            <small>{preset.when}</small>
          </div>
        ))}
        <div className="when-picker-rule" role="presentation" />
        <div
          id={`${id}-${CUSTOM_WHEN}`}
          role="option"
          aria-selected={pick === CUSTOM_WHEN}
          className="when-picker-row"
          onClick={() => { setPick(CUSTOM_WHEN); requestAnimationFrame(() => customField.current?.focus()); }}
        >
          <CalendarDays size={14} aria-hidden="true" />
          <span>Pick a date and time…</span>
          <ChevronRight size={14} className="when-picker-more" aria-hidden="true" />
        </div>
      </div>
      {pick === CUSTOM_WHEN ? (
        <input
          ref={customField}
          className="when-picker-custom"
          type="datetime-local"
          aria-label="Date and time"
          value={custom}
          min={localDateTimeInput(now())}
          onChange={(event) => setCustom(event.target.value)}
          onKeyDown={(event) => {
            if (isImeComposing(event.nativeEvent)) return;
            if (event.key === "Enter" && at !== undefined) { event.preventDefault(); onConfirm?.(); }
          }}
        />
      ) : null}
    </div>
  );
}
