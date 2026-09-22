import type { SVGProps } from "react";

function Badge({ label, color, ...props }: SVGProps<SVGSVGElement> & { label: string; color: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <rect x="1" y="1" width="22" height="22" rx="5" fill={color} />
    <text x="12" y="16" textAnchor="middle" fill="white" fontSize={label.length > 1 ? 9 : 11} fontWeight="800" fontFamily="ui-sans-serif, sans-serif">{label}</text>
  </svg>;
}

export function EditorIcon({ editorId, ...props }: SVGProps<SVGSVGElement> & { editorId?: string }) {
  if (editorId === "code") {
    return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path fill="#22a7f2" d="M17.6 2 7.9 10.4 3.8 7.3 2 9.1 6.2 12 2 14.9l1.8 1.8 4.1-3.1 9.7 8.4 4.4-2.1V4.1L17.6 2Zm-.8 5.5v9L10.9 12l5.9-4.5Z" />
    </svg>;
  }
  if (editorId === "file-manager") {
    return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path fill="#5aa9e6" d="M2 6.5A2.5 2.5 0 0 1 4.5 4h4.2l2 2h8.8A2.5 2.5 0 0 1 22 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5v-11Z" />
    </svg>;
  }
  const badge = editorId ? BADGES[editorId] : undefined;
  return badge ? <Badge label={badge[0]} color={badge[1]} {...props} /> : <Badge label="›_" color="#66665f" {...props} />;
}

/** A letter mark in the brand's colour for every editor without a glyph of its own. */
const BADGES: Record<string, readonly [string, string]> = {
  cursor: ["C", "#e9e8e2"],
  "code-insiders": ["Ci", "#24bfa5"],
  codium: ["Co", "#2f80ed"],
  windsurf: ["W", "#0b9e8a"],
  trae: ["T", "#e0413d"],
  kiro: ["K", "#7c4dff"],
  antigravity: ["A", "#4285f4"],
  zed: ["Z", "#f0a43a"],
  subl: ["S", "#ff8a24"],
  idea: ["IJ", "#d14bf0"],
  aqua: ["AQ", "#27c2a0"],
  clion: ["CL", "#21d789"],
  datagrip: ["DG", "#22d88f"],
  dataspell: ["DS", "#087cfa"],
  goland: ["GO", "#0d7bf7"],
  phpstorm: ["PS", "#b345f1"],
  pycharm: ["PC", "#21d789"],
  rider: ["RD", "#c90f5e"],
  rubymine: ["RM", "#fe2857"],
  rustrover: ["RR", "#fe6d33"],
  webstorm: ["WS", "#07c3f2"],
};
