import type { SVGProps } from "react";
import { Folder, SquareCode } from "lucide-react";
import { EDITOR_ICON_PATHS } from "./editor-icon-paths.js";

const CODE_PATH = "M17.6 2 7.9 10.4 3.8 7.3 2 9.1 6.2 12 2 14.9l1.8 1.8 4.1-3.1 9.7 8.4 4.4-2.1V4.1L17.6 2Zm-.8 5.5v9L10.9 12l5.9-4.5Z";

/** The editor's monochrome mark, inheriting the control's text color. */
export function EditorIcon({ editorId, ...props }: SVGProps<SVGSVGElement> & { editorId?: string }) {
  if (editorId === "file-manager") return <Folder aria-hidden="true" {...props} />;
  const key = editorId === "dataspell" || editorId === "rustrover" ? "jetbrains" : editorId;
  const path = key === "code" || key === "code-insiders" ? CODE_PATH : key ? EDITOR_ICON_PATHS[key] : undefined;
  return path ? <svg viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" aria-hidden="true" {...props}>
    <path d={path} />
  </svg> : <SquareCode aria-hidden="true" {...props} />;
}
