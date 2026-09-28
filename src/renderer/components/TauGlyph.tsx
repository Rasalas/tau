/** Tau's τ from assets/icon/tau-glyph.svg, drawn in the text colour. */
export function TauGlyph({ className }: { className?: string }) {
  // Inline: the global `svg { stroke-width }` for line icons outranks an attribute.
  return <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false"
    fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" style={{ strokeWidth: 5.11 }}>
    <path d="M4.21 6.47L26.62 6.47" />
    <path d="M14.43 6.47L14.43 21.31C14.43 24.79 17.25 27.61 20.72 27.61C23.08 27.61 24.22 26.96 25.83 25.84" />
  </svg>;
}
