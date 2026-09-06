import type { SVGProps } from "react";

function Badge({ label, color, ...props }: SVGProps<SVGSVGElement> & { label: string; color: string }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
    <rect x="1" y="1" width="22" height="22" rx="5" fill={color} />
    <text x="12" y="16" textAnchor="middle" fill="white" fontSize="11" fontWeight="800" fontFamily="ui-sans-serif, sans-serif">{label}</text>
  </svg>;
}

export function EditorIcon({ editorId, ...props }: SVGProps<SVGSVGElement> & { editorId?: string }) {
  if (editorId === "code") {
    return <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <path fill="#22a7f2" d="M17.6 2 7.9 10.4 3.8 7.3 2 9.1 6.2 12 2 14.9l1.8 1.8 4.1-3.1 9.7 8.4 4.4-2.1V4.1L17.6 2Zm-.8 5.5v9L10.9 12l5.9-4.5Z" />
    </svg>;
  }
  if (editorId === "cursor") return <Badge label="C" color="#e9e8e2" {...props} />;
  if (editorId === "zed") return <Badge label="Z" color="#f0a43a" {...props} />;
  if (editorId === "subl") return <Badge label="S" color="#ff8a24" {...props} />;
  if (editorId === "idea") return <Badge label="IJ" color="#d14bf0" {...props} />;
  if (editorId === "nvim") return <Badge label="N" color="#58a64a" {...props} />;
  return <Badge label="›_" color="#66665f" {...props} />;
}
