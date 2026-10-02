import type { CSSProperties, SVGProps } from "react";
import { Folder, SquareCode } from "lucide-react";
import { EDITOR_ICON_PATHS } from "./editor-icon-paths.js";

const CODE_PATH = "M17.6 2 7.9 10.4 3.8 7.3 2 9.1 6.2 12 2 14.9l1.8 1.8 4.1-3.1 9.7 8.4 4.4-2.1V4.1L17.6 2Zm-.8 5.5v9L10.9 12l5.9-4.5Z";

const BRAND_COLORS: Readonly<Record<string, string>> = {
  code: "#22a7f2", "code-insiders": "#24bfa5", codium: "#2f80ed",
  windsurf: "#0b9e8a", trae: "#e0413d", kiro: "#a56eff", antigravity: "#4285f4",
  zed: "#f0a43a", subl: "#ff8a24", idea: "#d14bf0", aqua: "#27c2a0",
  clion: "#21d789", datagrip: "#22d88f", dataspell: "#087cfa", goland: "#0d7bf7",
  phpstorm: "#b345f1", pycharm: "#21d789", rider: "#c90f5e", rubymine: "#fe2857",
  rustrover: "#fe6d33", webstorm: "#07c3f2", "file-manager": "#5aa9e6",
};

/** Monochrome at rest; the control reveals its brand color on hover or keyboard focus. */
export function EditorIcon({ editorId, ...props }: SVGProps<SVGSVGElement> & { editorId?: string }) {
  const iconProps = {
    ...props,
    style: { "--editor-brand": editorId ? BRAND_COLORS[editorId] : undefined, ...props.style } as CSSProperties,
  };
  if (editorId === "file-manager") return <Folder aria-hidden="true" {...iconProps} />;
  const key = editorId === "dataspell" || editorId === "rustrover" ? "jetbrains" : editorId;
  const path = key === "code" || key === "code-insiders" ? CODE_PATH : key ? EDITOR_ICON_PATHS[key] : undefined;
  return path ? <svg viewBox="0 0 24 24" fill="currentColor" fillRule={key === "antigravity" || key === "kiro" ? "evenodd" : undefined} aria-hidden="true" {...iconProps}>
    <path d={path} />
  </svg> : <SquareCode aria-hidden="true" {...iconProps} />;
}
