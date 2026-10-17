import { Search, X } from "lucide-react";

/** The filter shared by Settings lists, including Escape and the clear button. */
export function SettingsFilter({ label, placeholder, value, onChange, className, spellCheck }: {
  label: string;
  placeholder: string;
  value: string;
  onChange(value: string): void;
  className: string;
  spellCheck?: boolean;
}) {
  return <label className={`settings-filter ${className}`}>
    <Search size={14} aria-hidden />
    <input type="search" value={value} placeholder={placeholder} aria-label={label} spellCheck={spellCheck} onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape" && value) { event.preventDefault(); event.stopPropagation(); onChange(""); } }} />
    {value ? <button type="button" className="tau-icon-button" aria-label="Clear the filter" onClick={() => onChange("")}><X size={13} /></button> : null}
  </label>;
}
