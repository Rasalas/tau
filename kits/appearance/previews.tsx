import { useState, type CSSProperties } from "react";
import { Moon, PenLine, Sun } from "lucide-react";
import { currentToken } from "./editor.js";
import type { Appearance } from "./protocol.js";

/** The tokens a miniature of the window is drawn with. */
export const PREVIEW_TOKENS = ["--shell", "--rail", "--chrome", "--raised", "--field", "--line", "--muted", "--acid"] as const;
export type PreviewToken = (typeof PREVIEW_TOKENS)[number];
export type PreviewColors = Readonly<Record<PreviewToken, string>>;

const OWN_STYLES = ["tau-appearance", "tau-appearance-editor"];

/**
 * Reads the window's tokens as they are without this kit's stylesheets: the
 * themes chosen per scheme and a draft in the editor. Nothing is painted in
 * between, because the sheets are back before the script yields.
 */
export function withoutOwnStyles<T>(read: () => T, doc: Document = document): T {
  const sheets = OWN_STYLES.map((id) => doc.getElementById(id)).filter((element): element is HTMLStyleElement => element instanceof HTMLStyleElement && !element.disabled);
  for (const sheet of sheets) sheet.disabled = true;
  try { return read(); } finally { for (const sheet of sheets) sheet.disabled = false; }
}

/** Tau's own colours for a scheme; a token the window does not answer falls back to the live one. */
export function baseColors(scheme: Appearance): PreviewColors {
  const read = withoutOwnStyles(() => PREVIEW_TOKENS.map((name) => [name, currentToken(name, scheme)] as const));
  return Object.fromEntries(read.map(([name, value]) => [name, value ?? `var(${name})`])) as PreviewColors;
}

/** A theme's colours for a scheme, over Tau's for what it leaves out. */
export function themeColors(tokens: Readonly<Record<string, string>> | undefined, base: PreviewColors): PreviewColors {
  if (!tokens) return base;
  return Object.fromEntries(PREVIEW_TOKENS.map((name) => [name, tokens[name] ?? base[name]])) as PreviewColors;
}

function Pane({ colors, clip }: { colors: PreviewColors; clip?: "left" | "right" }) {
  const line = colors["--line"];
  const at = (style: CSSProperties) => ({ position: "absolute", ...style }) as CSSProperties;
  return (
    <span className="appearance-wireframe-pane" data-clip={clip}>
      <span style={at({ inset: 0, background: colors["--shell"] })} />
      <span style={at({ left: 0, right: 0, top: 0, height: "13%", background: colors["--chrome"], boxShadow: `inset 0 -1px 0 ${line}` })} />
      <span style={at({ left: 0, top: "13%", bottom: 0, width: "22%", background: colors["--rail"], boxShadow: `inset -1px 0 0 ${line}` })} />
      <span style={at({ left: "3%", top: "22%", width: "16%", height: "8%", borderRadius: 3, background: colors["--raised"] })} />
      {[34, 46].map((top) => <span key={top} style={at({ left: "4%", top: `${top}%`, width: "12%", height: "4%", borderRadius: 2, background: colors["--muted"], opacity: 0.45 })} />)}
      <span style={at({ right: 0, top: "13%", bottom: 0, width: "15%", background: colors["--rail"], boxShadow: `inset 1px 0 0 ${line}` })} />
      <span style={at({ right: "22%", top: "22%", width: "24%", height: "11%", borderRadius: 4, background: colors["--raised"] })} />
      {[42, 52].map((top, index) => <span key={top} style={at({ left: "27%", top: `${top}%`, width: index ? "26%" : "36%", height: "4%", borderRadius: 2, background: colors["--muted"], opacity: 0.5 })} />)}
      <span style={at({ left: "26%", right: "19%", bottom: "8%", height: "16%", borderRadius: 4, background: colors["--field"], boxShadow: `inset 0 0 0 1px ${line}` })}>
        <span style={at({ right: "4%", top: "25%", height: "50%", aspectRatio: "1", borderRadius: "50%", background: colors["--acid"] })} />
      </span>
    </span>
  );
}

/** The window in miniature: title bar, rail, a short conversation, the composer and the dock. */
export function Wireframe({ panes }: { panes: ReadonlyArray<{ colors: PreviewColors; clip?: "left" | "right" }> }) {
  return <span className="appearance-wireframe" aria-hidden>{panes.map((pane) => <Pane key={pane.clip ?? "whole"} {...pane} />)}</span>;
}

export type Mode = "system" | Appearance;
const MODE_TILES: ReadonlyArray<{ mode: Mode; label: string; title: string }> = [
  { mode: "system", label: "System", title: "Follow this machine's light or dark setting" },
  { mode: "light", label: "Light", title: "Always light" },
  { mode: "dark", label: "Dark", title: "Always dark" },
];

/** The three appearance tiles, each showing the theme it would paint with. */
export function ModeTiles({ value, colors, onChange }: { value: string; colors: Readonly<Record<Appearance, PreviewColors>>; onChange(mode: Mode): void }) {
  return (
    <div className="appearance-mode-tiles" role="group" aria-label="Mode">
      {MODE_TILES.map(({ mode, label, title }) => (
        <button key={mode} type="button" className="appearance-tile" aria-pressed={value === mode} data-tooltip={title} onClick={() => onChange(mode)}>
          <Wireframe panes={mode === "system" ? [{ colors: colors.light, clip: "left" }, { colors: colors.dark, clip: "right" }] : [{ colors: colors[mode] }]} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

/** One theme's swatch for one scheme: its surface, with the rail and the accent in it. */
function Swatch({ colors }: { colors: PreviewColors }) {
  return (
    <span className="appearance-swatch" aria-hidden style={{ background: `linear-gradient(135deg, ${colors["--rail"]} 0 38%, ${colors["--shell"]} 38%)`, boxShadow: `inset 0 0 0 1px ${colors["--line"]}` }}>
      <i style={{ background: colors["--acid"] }} />
    </span>
  );
}

export interface ThemeCardModel {
  id: string;
  name: string;
  /** The schemes the theme has colours for. */
  schemes: Partial<Record<Appearance, PreviewColors>>;
}

/**
 * A theme card: a swatch per scheme it has. A swatch gives the
 * theme that scheme; the name gives it every scheme it has. A ring and a sun
 * or moon mark what it paints now.
 */
export function ThemeCard({ theme, active, onUse, onEdit, editLabel }: {
  theme: ThemeCardModel;
  active: ReadonlyArray<Appearance>;
  onUse(schemes: readonly Appearance[]): void;
  onEdit(): void;
  editLabel: string;
}) {
  const schemes = (["light", "dark"] as const).filter((scheme) => theme.schemes[scheme]);
  return (
    <div className="appearance-theme-card" data-active={active.length > 0 ? "" : undefined}>
      <div className="appearance-theme-swatches">
        {schemes.map((scheme) => {
          const on = active.includes(scheme);
          return (
            <button key={scheme} type="button" className="appearance-swatch-button" aria-pressed={on} aria-label={`Use ${theme.name} for the ${scheme} scheme`} data-tooltip={`${scheme === "light" ? "Light" : "Dark"}: ${theme.name}`} onClick={() => onUse([scheme])}>
              <Swatch colors={theme.schemes[scheme]!} />
              {on ? <b className="appearance-swatch-mark">{scheme === "light" ? <Sun size={9} /> : <Moon size={9} />}</b> : null}
            </button>
          );
        })}
      </div>
      <div className="appearance-theme-foot">
        <button type="button" className="appearance-theme-name" aria-label={`Use ${theme.name}${schemes.length > 1 ? " for both schemes" : ""}`} onClick={() => onUse(schemes)}>{theme.name}</button>
        <button type="button" className="appearance-icon-button" aria-label={`${editLabel} ${theme.name}`} data-tooltip={editLabel} onClick={onEdit}><PenLine size={12} /></button>
      </div>
    </div>
  );
}

/** Sidebar, conversation and dock that open and close at the chosen speed; a click plays it again. */
export function PanelMotionPreview({ ms }: { ms: number }) {
  const [open, setOpen] = useState(true);
  return (
    <button type="button" className="appearance-motion-preview" data-open={open ? "" : undefined} aria-label="Play the panel animation" style={{ "--preview-motion": `${ms}ms` } as CSSProperties} onClick={() => setOpen(!open)}>
      <span className="side" aria-hidden />
      <span className="main" aria-hidden><i /><i /><i /></span>
      <span className="dock" aria-hidden />
    </button>
  );
}
