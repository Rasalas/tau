type DomRectOverrides = Partial<Pick<DOMRect, "top" | "bottom" | "left" | "right" | "width" | "height" | "x" | "y">>;

/** Consistent geometry for jsdom tests, where layout is otherwise unavailable. */
export function testDomRect(overrides: DomRectOverrides = {}): DOMRect {
  const top = overrides.top ?? 0;
  const left = overrides.left ?? 0;
  const width = overrides.width ?? 780;
  const height = overrides.height ?? 0;
  return {
    top,
    bottom: overrides.bottom ?? top + height,
    left,
    right: overrides.right ?? left + width,
    width,
    height,
    x: overrides.x ?? left,
    y: overrides.y ?? top,
    toJSON: () => ({}),
  } as DOMRect;
}
