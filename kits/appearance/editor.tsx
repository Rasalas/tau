import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, RotateCcw, X } from "lucide-react";
import type { HostExtensionClient, PreferencesStore } from "tau";
import { parseHex, toHex } from "./color.js";
import { derivePalette } from "./palette.js";
import { APPEARANCE_EXTENSION_ID as ID, SETTING_KEYS, type Appearance, type SaveThemeResult } from "./protocol.js";
import { previewCss, schemeSides } from "./theme-css.js";
import { DERIVED_GROUPS, TOKEN_GROUPS, themeIdFromName, validateTokens } from "./tokens.js";

const ACCENT_TOKENS = new Set(TOKEN_GROUPS.find((group) => group.id === "accent")!.tokens.map(([name]) => name));

export interface ThemeDraft {
  /** The theme being edited, when it was saved before. */
  id?: string;
  name: string;
  appearance: Appearance;
  /** The three colours the basic fields show; changing one derives the palette again. */
  seed: { background: string; foreground: string; accent: string };
  tokens: Record<string, string>;
}

interface EditorState { draft?: ThemeDraft; saving: boolean; error?: string }

/** The one editor session of this window. The panel paints its draft on the whole window. */
export class ThemeEditorStore {
  private state: EditorState = { saving: false };
  private readonly listeners = new Set<() => void>();

  getSnapshot = (): EditorState => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  open(draft: ThemeDraft): void { this.set({ draft, error: undefined, saving: false }); }
  close(): void { this.set({ draft: undefined, error: undefined, saving: false }); }

  update(change: (draft: ThemeDraft) => ThemeDraft): void {
    if (this.state.draft) this.set({ draft: change(this.state.draft), error: undefined });
  }

  set(patch: Partial<EditorState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** The window's token for a scheme as a hex colour, when it is one. */
export function currentToken(name: string, appearance: Appearance, root: HTMLElement = document.documentElement): string | undefined {
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  if (!raw) return undefined;
  const value = schemeSides(raw)[appearance];
  const parsed = parseHex(value);
  return parsed ? toHex(parsed) : undefined;
}

/** A draft that starts as what the window shows now, so opening the editor changes nothing yet. */
export function draftFromWindow(appearance: Appearance, name = "My theme"): ThemeDraft {
  const tokens: Record<string, string> = {};
  for (const group of TOKEN_GROUPS) for (const [token] of group.tokens) {
    const value = currentToken(token, appearance);
    if (value) tokens[token] = value;
  }
  return {
    name,
    appearance,
    seed: { background: tokens["--shell"] ?? "#1a1a19", foreground: tokens["--ink"] ?? "#e9e6e0", accent: tokens["--acid"] ?? "#6b93e0" },
    tokens,
  };
}

function ColorField({ label, value, placeholder, onChange, onReset }: {
  label: string;
  value?: string;
  placeholder?: string;
  onChange(value: string): void;
  onReset?(): void;
}) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const commit = (next: string) => {
    const parsed = parseHex(next);
    if (parsed) onChange(toHex(parsed));
    else setText(value ?? "");
  };
  return (
    <span className="appearance-color-field">
      <input type="color" aria-label={`${label} colour`} value={value ?? placeholder ?? "#000000"} onChange={(event) => onChange(event.target.value)} />
      <input
        type="text"
        aria-label={label}
        spellCheck={false}
        value={text}
        placeholder={placeholder ?? "inherits"}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => { if (text !== (value ?? "")) commit(text); }}
        onKeyDown={(event) => { if (event.key === "Enter") commit(text); }}
      />
      {onReset && value ? <button type="button" className="appearance-icon-button" aria-label={`Reset ${label}`} title="Leave it to Tau's default" onClick={onReset}><RotateCcw size={11} /></button> : null}
    </span>
  );
}

/**
 * T3 Code's theme editor, in Tau's tokens: a floating panel over the window,
 * so the draft can be judged on the thread, the rail and the panels while it
 * is tuned. Three colours derive a palette; every token can be set on its own.
 */
export function ThemeEditorPanel({ store, host, preferences, notify }: {
  store: ThemeEditorStore;
  host: HostExtensionClient;
  preferences: PreferencesStore;
  notify(message: string): void;
}) {
  const { draft, saving, error } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [allTokens, setAllTokens] = useState(false);
  const [filter, setFilter] = useState("");

  // The draft is painted over the window until the editor closes.
  useEffect(() => {
    if (!draft) return;
    const style = document.createElement("style");
    style.id = "tau-appearance-editor";
    style.textContent = previewCss(draft.appearance, draft.tokens);
    document.head.append(style);
    return () => style.remove();
  }, [draft]);

  useEffect(() => {
    if (!draft) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Node) || !document.querySelector(".appearance-editor")?.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      store.close();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [draft, store]);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return TOKEN_GROUPS.map((group) => ({
      ...group,
      tokens: group.tokens.filter(([name, role]) => !needle || name.includes(needle) || role.toLowerCase().includes(needle)),
    })).filter((group) => group.tokens.length > 0);
  }, [filter]);

  if (!draft) return null;
  const problems = validateTokens(draft.tokens);
  const id = draft.id ?? themeIdFromName(draft.name);

  const setSeed = (key: keyof ThemeDraft["seed"], value: string) => store.update((current) => {
    const seed = { ...current.seed, [key]: value };
    const derived = derivePalette({ appearance: current.appearance, ...seed });
    // The accent moves only the accent tokens; background and text move every derived group.
    const moved = key === "accent" ? Object.fromEntries(Object.entries(derived).filter(([token]) => ACCENT_TOKENS.has(token))) : derived;
    return { ...current, seed, tokens: { ...current.tokens, ...moved } };
  });
  const setAppearance = (appearance: Appearance) => store.update((current) => ({
    ...current, appearance, tokens: { ...current.tokens, ...derivePalette({ appearance, ...current.seed }) },
  }));
  const setToken = (token: string, value: string | undefined) => store.update((current) => {
    const tokens = { ...current.tokens };
    if (value === undefined) delete tokens[token];
    else tokens[token] = value;
    return { ...current, tokens };
  });

  const save = async () => {
    if (!id) { store.set({ error: "Give the theme a name." }); return; }
    if (problems.length > 0) { store.set({ error: problems[0]!.message }); return; }
    store.set({ saving: true, error: undefined });
    try {
      const result = await host.invoke("save-theme", { id, name: draft.name.trim(), appearance: draft.appearance, tokens: draft.tokens }) as SaveThemeResult;
      if (!result || "error" in result) { store.set({ saving: false, error: result?.error ?? "The theme was not saved." }); return; }
      preferences.setValue(ID, draft.appearance === "dark" ? SETTING_KEYS.themeDark : SETTING_KEYS.themeLight, result.id);
      await preferences.syncFromHost();
      notify(`${draft.name.trim()} saved to ${result.path} and set as the ${draft.appearance} theme.`);
      store.close();
    } catch (failure) {
      store.set({ saving: false, error: failure instanceof Error ? failure.message : String(failure) });
    }
  };

  return createPortal(
    <aside className="appearance-editor" role="dialog" aria-label="Theme editor" data-preview-overlay="" data-overlay="false">
      <header>
        <strong>Theme editor</strong>
        <span className="appearance-editor-spacer" />
        <button type="button" className="appearance-icon-button" aria-label="Close the theme editor" onClick={() => store.close()}><X size={14} /></button>
      </header>
      <div className="appearance-editor-body">
        <label className="appearance-editor-field">
          <span>Theme name</span>
          <input type="text" aria-label="Theme name" value={draft.name} maxLength={48} onChange={(event) => store.update((current) => ({ ...current, name: event.target.value }))} />
          <small>{id ? <>Saved as <code>{id}.css</code> in your themes folder.</> : "A name made of letters or digits."}</small>
        </label>
        <div className="appearance-editor-field">
          <span>Appearance</span>
          <div className="segmented" role="group" aria-label="Theme appearance">
            {(["light", "dark"] as const).map((appearance) => (
              <button key={appearance} type="button" className={draft.appearance === appearance ? "active" : ""} aria-pressed={draft.appearance === appearance} onClick={() => setAppearance(appearance)}>
                {appearance === "light" ? "Light" : "Dark"}
              </button>
            ))}
          </div>
        </div>
        <section className="appearance-editor-colors" aria-label="Colors">
          <h3>Colors</h3>
          <div className="appearance-token-row"><span>Background</span><ColorField label="Background" value={draft.seed.background} onChange={(value) => setSeed("background", value)} /></div>
          <div className="appearance-token-row"><span>Text</span><ColorField label="Text" value={draft.seed.foreground} onChange={(value) => setSeed("foreground", value)} /></div>
          <div className="appearance-token-row"><span>Accent</span><ColorField label="Accent" value={draft.seed.accent} onChange={(value) => setSeed("accent", value)} /></div>
          <button type="button" className="appearance-editor-disclosure" aria-expanded={allTokens} onClick={() => setAllTokens(!allTokens)}>
            {allTokens ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Every token
          </button>
          {allTokens ? <>
            <input type="search" className="appearance-editor-filter" aria-label="Filter colors" placeholder="Filter tokens" value={filter} onChange={(event) => setFilter(event.target.value)} />
            {groups.map((group) => (
              <div className="appearance-token-group" key={group.id}>
                <h4>{group.title}{DERIVED_GROUPS.has(group.id) ? <small>follows the three colours</small> : null}</h4>
                {group.tokens.map(([name, role]) => (
                  <div className="appearance-token-row" key={name} title={role}>
                    <span><code>{name}</code><small>{role}</small></span>
                    <ColorField
                      label={name}
                      value={draft.tokens[name]}
                      placeholder={currentToken(name, draft.appearance)}
                      onChange={(value) => setToken(name, value)}
                      onReset={() => setToken(name, undefined)}
                    />
                  </div>
                ))}
              </div>
            ))}
          </> : null}
        </section>
      </div>
      <footer>
        {error ? <p className="appearance-editor-error" role="alert">{error}</p> : null}
        <button type="button" className="text-button" onClick={() => store.close()}>Discard</button>
        <button type="button" className="appearance-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save theme"}</button>
      </footer>
    </aside>,
    document.body,
  );
}
