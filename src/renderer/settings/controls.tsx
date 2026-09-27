import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, ChevronDown, Copy, Info, Plus, RotateCw, X } from "lucide-react";
import { tooltipProps } from "../components/ui/Tooltip";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { Empty, Skeleton } from "../components/ui/Feedback";
import { useHostClient } from "../host-client-context";
import "./controls.css";

/*
 * The controls a Settings page is built from, core's and every kit's alike
 * (docs/EXTENSIONS.md, "The controls"). One height per tier: 30 px on a
 * desktop, 44 px where the pointer is a finger. Every control takes a
 * `label`: its accessible name when the row's title is not next to it.
 */

type Tone = "neutral" | "accent" | "success" | "warn" | "danger";

/** On or off, for a change that applies at once. */
export function Switch({ label, checked, disabled, role = "switch", onChange }: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  /** `checkbox` for an option in a list of several; the look is the same. */
  role?: "switch" | "checkbox";
  onChange(next: boolean): void;
}) {
  return (
    <button type="button" className={`switch ${checked ? "on" : ""}`} role={role} aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <i />
    </button>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** Draws the option as this glyph alone; `label` becomes its tooltip and name. */
  icon?: ReactNode;
  disabled?: boolean;
}

/**
 * Two to four short choices side by side, one of them chosen (a radio group:
 * arrows move and choose). More, or longer, choices belong in a `Select`.
 */
export function SegmentedControl<T extends string>({ label, value, options, disabled, onChange }: {
  label: string;
  value: T | undefined;
  options: ReadonlyArray<ChoiceOption<T>>;
  disabled?: boolean;
  onChange(value: T): void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.filter((option) => !option.disabled);
  const move = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step || enabled.length === 0) return;
    event.preventDefault();
    const at = enabled.indexOf(options[index]!);
    const next = enabled[(at + step + enabled.length) % enabled.length]!;
    onChange(next.value);
    refs.current[options.indexOf(next)]?.focus();
  };
  const focusable = options.some((option) => option.value === value) ? value : enabled[0]?.value;
  return (
    <div className="tau-segmented" role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => { refs.current[index] = element; }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={option.icon ? option.label : undefined}
          tabIndex={option.value === focusable ? 0 : -1}
          disabled={disabled || option.disabled}
          data-icon={option.icon ? "" : undefined}
          {...(option.icon ? tooltipProps(option.label) : {})}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => move(event, index)}
        >
          {option.icon ?? option.label}
        </button>
      ))}
    </div>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

/** One choice of many: the system's own menu, which is what a keyboard, a screen reader and a phone know best. */
export function Select<T extends string>({ label, value, options, disabled, width = "md", placeholder, onChange }: {
  label: string;
  value: T | undefined;
  options: ReadonlyArray<SelectOption<T>>;
  disabled?: boolean;
  width?: FieldWidth;
  /** Shown while `value` is none of the options. */
  placeholder?: string;
  onChange(value: T): void;
}) {
  const known = options.some((option) => option.value === value);
  return (
    <span className="tau-select" data-width={width}>
      <select aria-label={label} value={known ? value : ""} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
        {known ? null : <option value="" disabled>{placeholder ?? "Choose…"}</option>}
        {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
      </select>
      <ChevronDown size={14} aria-hidden />
    </span>
  );
}

export type FieldWidth = "sm" | "md" | "lg" | "full";

/** What a draft field shows under itself: the error of the last commit that failed. */
function FieldShell({ width, unit, error, errorId, children }: { width: FieldWidth; unit?: string | undefined; error?: string | undefined; errorId: string; children: ReactNode }) {
  return (
    <span className="tau-field-shell" data-width={width}>
      <span className="tau-field" data-invalid={error ? "" : undefined}>
        {children}
        {unit ? <span className="tau-field-unit" aria-hidden>{unit}</span> : null}
      </span>
      {error ? <span className="tau-field-error" id={errorId} role="alert">{error}</span> : null}
    </span>
  );
}

/**
 * A draft that is written when focus leaves the field or on Enter, and put
 * back on Escape. A value `validate` refuses stays in the field with the
 * reason under it, so nothing typed is lost.
 */
function useDraft(value: string, commit: (text: string) => string | undefined) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setDraft(value); }, [value]);
  const apply = () => {
    editing.current = false;
    if (draft === value) { setError(undefined); return; }
    const problem = commit(draft);
    setError(problem);
    if (problem) editing.current = true;
  };
  return {
    draft,
    error,
    onChange: (text: string) => { editing.current = true; setDraft(text); if (error) setError(undefined); },
    onBlur: apply,
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") { event.preventDefault(); apply(); }
      if (event.key === "Escape" && (draft !== value || error)) {
        event.preventDefault();
        event.stopPropagation();
        editing.current = false;
        setDraft(value);
        setError(undefined);
      }
    },
  };
}

/**
 * A number with its unit, written on blur or Enter. Empty means "not set":
 * `onClear` runs and the placeholder (the default) shows. Out of range or not
 * a number keeps the draft and says why.
 */
export function NumberField({ label, value, min, max, step = 1, integer = false, unit, placeholder = "Default", width = "sm", disabled, validate, onCommit, onClear }: {
  label: string;
  value: number | undefined;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  /** Drawn inside the field, after the number: `px`, `ms`, `tokens`. */
  unit?: string;
  placeholder?: string;
  width?: FieldWidth;
  disabled?: boolean;
  /** A rule of the setting's own, after range and whole numbers: why `value` is refused. */
  validate?(value: number): string | undefined;
  onCommit(value: number): void;
  /** Without it, an emptied field is refused like any other invalid value. */
  onClear?(): void;
}) {
  const errorId = useId();
  const field = useDraft(value === undefined ? "" : String(value), (text) => {
    const problem = numberProblem(text, { min, max, integer, clearable: onClear !== undefined }) ?? (text.trim() ? validate?.(Number(text)) : undefined);
    if (problem) return problem;
    if (!text.trim()) onClear?.();
    else onCommit(Number(text));
    return undefined;
  });
  return (
    <FieldShell width={width} unit={unit} error={field.error} errorId={errorId}>
      <input
        type="text"
        inputMode={integer ? "numeric" : "decimal"}
        role="spinbutton"
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label={label}
        aria-invalid={field.error ? true : undefined}
        aria-describedby={field.error ? errorId : undefined}
        placeholder={placeholder}
        disabled={disabled}
        value={field.draft}
        onChange={(event) => field.onChange(event.target.value)}
        onBlur={field.onBlur}
        onKeyDown={(event) => {
          if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !disabled) {
            event.preventDefault();
            const base = Number(field.draft.trim() || value || min || 0);
            if (!Number.isFinite(base)) return;
            const next = clamp(round(base + (event.key === "ArrowUp" ? step : -step)), min, max);
            field.onChange(String(next));
            return;
          }
          field.onKeyDown(event);
        }}
      />
    </FieldShell>
  );
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function clamp(value: number, min?: number, max?: number): number {
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));
}

/** Why `text` is no value a `NumberField` takes, or undefined when it is one. */
export function numberProblem(text: string, { min, max, integer = false, clearable = true }: { min?: number | undefined; max?: number | undefined; integer?: boolean; clearable?: boolean }): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return clearable ? undefined : "Enter a number.";
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return "Enter a number.";
  if (integer && !Number.isInteger(parsed)) return "Enter a whole number.";
  if (min !== undefined && max !== undefined && (parsed < min || parsed > max)) return `Enter a number from ${min} to ${max}.`;
  if (min !== undefined && parsed < min) return `Enter ${min} or more.`;
  if (max !== undefined && parsed > max) return `Enter ${max} or less.`;
  return undefined;
}

/** A line of text, written on blur or Enter; `validate` answers why a draft is refused. */
export function TextField({ label, value, placeholder, width = "lg", mono = false, disabled, validate, onCommit }: {
  label: string;
  value: string;
  placeholder?: string;
  width?: FieldWidth;
  /** For paths, commands and ids. */
  mono?: boolean;
  disabled?: boolean;
  validate?(text: string): string | undefined;
  onCommit(text: string): void;
}) {
  const errorId = useId();
  const field = useDraft(value, (text) => {
    const problem = validate?.(text);
    if (problem) return problem;
    onCommit(text);
    return undefined;
  });
  return (
    <FieldShell width={width} error={field.error} errorId={errorId}>
      <input
        type="text"
        aria-label={label}
        aria-invalid={field.error ? true : undefined}
        aria-describedby={field.error ? errorId : undefined}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        data-mono={mono ? "" : undefined}
        value={field.draft}
        onChange={(event) => field.onChange(event.target.value)}
        onBlur={field.onBlur}
        onKeyDown={field.onKeyDown}
      />
    </FieldShell>
  );
}

/**
 * A list of short values to add to and remove from: folders, hosts,
 * patterns. Each change is written at once, as the whole list.
 */
export function ListField({ label, items, placeholder, empty = "Nothing added yet.", mono = false, disabled, validate, onChange }: {
  label: string;
  items: readonly string[];
  placeholder?: string;
  /** What the list says while it has no entry. */
  empty?: string;
  mono?: boolean;
  disabled?: boolean;
  validate?(text: string): string | undefined;
  onChange(items: string[]): void;
}) {
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const add = () => {
    const text = draft.trim();
    if (!text) { setError("Enter a value to add."); return; }
    if (items.includes(text)) { setError("It is on the list already."); return; }
    const problem = validate?.(text);
    if (problem) { setError(problem); return; }
    onChange([...items, text]);
    setDraft("");
    setError(undefined);
    input.current?.focus();
  };
  return (
    <div className="tau-list-field" role="group" aria-label={label}>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item}>
              <span data-mono={mono ? "" : undefined}>{item}</span>
              <button type="button" className="tau-icon-button" aria-label={`Remove ${item}`} {...tooltipProps("Remove")} disabled={disabled} onClick={() => onChange(items.filter((entry) => entry !== item))}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="tau-list-field-empty">{empty}</p>}
      <form className="tau-list-field-add" onSubmit={(event) => { event.preventDefault(); add(); }}>
        <FieldShell width="full" error={error} errorId={errorId}>
          <input
            ref={input}
            type="text"
            aria-label={`Add to ${label}`}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            placeholder={placeholder}
            disabled={disabled}
            spellCheck={false}
            data-mono={mono ? "" : undefined}
            value={draft}
            onChange={(event) => { setDraft(event.target.value); if (error) setError(undefined); }}
          />
        </FieldShell>
        <Button type="submit" icon={<Plus size={14} />} disabled={disabled}>Add</Button>
      </form>
    </div>
  );
}

export interface ValueListItem {
  label: string;
  value: ReactNode;
  /** Paths, versions, ids. */
  mono?: boolean;
  /** Text a copy button next to the value puts on the clipboard. */
  copy?: string;
}

/** Facts, label beside value: a version, a folder, a fingerprint. */
export function ValueList({ items, label }: { items: readonly ValueListItem[]; label?: string }) {
  const client = useHostClient();
  const [copied, setCopied] = useState<string>();
  const copy = (text: string, what: string) => {
    const done = () => setCopied(what);
    if (client) void client.copyText(text).then(done, () => undefined);
    else void navigator.clipboard?.writeText(text).then(done, () => undefined);
  };
  return (
    <dl className="tau-values" aria-label={label}>
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd data-mono={item.mono ? "" : undefined}>
            <span>{item.value}</span>
            {item.copy ? (
              <button type="button" className="tau-icon-button" aria-label={`Copy ${item.label}`} {...tooltipProps(copied === item.label ? "Copied" : "Copy")} onClick={() => copy(item.copy!, item.label)}>
                <Copy size={13} />
              </button>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A state in a word or two, with a colour that repeats it: never the colour alone. */
export function Badge({ tone = "neutral", dot = false, children }: { tone?: Tone; dot?: boolean; children: ReactNode }) {
  return <span className="tau-badge" data-tone={tone}>{dot ? <i aria-hidden /> : null}{children}</span>;
}

/** More about a row than its description should carry; hover, focus or a long press shows it. */
export function HelpTip({ text, label = "More about this" }: { text: string; label?: string }) {
  return (
    <button type="button" className="tau-help-tip" aria-label={`${label}: ${text}`} {...tooltipProps(text, { side: "top" })}>
      <Info size={13} />
    </button>
  );
}

type ButtonVariant = "default" | "primary" | "danger" | "ghost";

/** The one button of a Settings page, in four weights; `busy` keeps it pressed-looking and inert. */
export function Button({ variant = "default", icon, busy = false, children, className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: ReactNode;
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      type={type}
      className={`tau-button${className ? ` ${className}` : ""}`}
      data-variant={variant}
      aria-busy={busy || undefined}
      disabled={props.disabled || busy}
    >
      {icon}{children}
    </button>
  );
}

/**
 * The actions that cannot be taken back, apart from the rest and last on the
 * page. Each `DangerAction` inside names what it removes and asks first.
 */
export function DangerZone({ title = "Danger zone", children }: { title?: string; children: ReactNode }) {
  return (
    <section className="tau-danger-zone" aria-label={title}>
      <h2><AlertTriangle size={13} aria-hidden />{title}</h2>
      <div className="tau-danger-zone-rows">{children}</div>
    </section>
  );
}

/**
 * One destructive action: what it does on the left, its button on the right,
 * a confirmation that names the object and the consequence. `confirmText`
 * makes the user type it first, for a loss that is hard to repair.
 */
export function DangerAction({ title, description, actionLabel, confirmTitle, confirmMessage, confirmText, disabled, disabledReason, busy, onConfirm }: {
  title: string;
  description?: ReactNode;
  actionLabel: string;
  confirmTitle: string;
  confirmMessage: ReactNode;
  confirmText?: string;
  disabled?: boolean;
  disabledReason?: string;
  busy?: boolean;
  onConfirm(): void;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <div className="tau-danger-action">
      <div>
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
      </div>
      <span {...tooltipProps(disabled ? disabledReason : undefined)}>
        <Button variant="danger" disabled={disabled} busy={busy} onClick={() => setAsking(true)}>{actionLabel}</Button>
      </span>
      {asking ? (
        <ConfirmDialog
          title={confirmTitle}
          message={confirmMessage}
          confirmLabel={actionLabel.replace(/…$/u, "")}
          destructive
          {...(confirmText ? { confirmText } : {})}
          onCancel={() => setAsking(false)}
          onConfirm={() => { setAsking(false); onConfirm(); }}
        />
      ) : null}
    </div>
  );
}

/**
 * What a page or a section shows instead of its rows: rows on their way
 * (`loading`), nothing yet with the next step (`empty`), or a failure that
 * says what happened and offers another try (`error`).
 */
export function SettingsState({ kind, title, description, action, rows = 2, onRetry }: {
  kind: "loading" | "empty" | "error";
  title?: ReactNode;
  description?: ReactNode;
  /** The next step, under the text: a button or a link. */
  action?: ReactNode;
  /** How many rows the skeleton stands in for. */
  rows?: number;
  onRetry?(): void;
}) {
  if (kind === "loading") {
    return (
      <div className="tau-settings-state" data-kind="loading" aria-busy="true" role="status" aria-label={typeof title === "string" ? title : "Loading"}>
        {Array.from({ length: rows }, (_, index) => <Skeleton key={index} className="tau-settings-state-row" />)}
      </div>
    );
  }
  return (
    <div className="tau-settings-state" data-kind={kind} role={kind === "error" ? "alert" : undefined}>
      <Empty
        size="compact"
        {...(kind === "error" ? { icon: <AlertTriangle size={18} /> } : {})}
        title={title ?? (kind === "error" ? "This did not load" : "Nothing here yet")}
        description={description}
      >
        {action}
        {kind === "error" && onRetry ? <Button icon={<RotateCw size={13} />} onClick={onRetry}>Try again</Button> : null}
      </Empty>
    </div>
  );
}
