// Page-side measurement for the screen comparison. App-neutral: a screen names
// the element for each probe per app, this code reads the same facts from both.

/**
 * `(probes) => result`, evaluated in the page. `probes` maps a name to a CSS
 * selector, optionally `selector@text-regex` to pick the tightest match whose
 * text matches. Each found element reports its box, its type and its colours.
 */
export const MEASURE = `(probes) => {
  const round = (value) => Math.round(value * 10) / 10;
  const pick = (spec) => {
    const at = spec.indexOf("@");
    const selector = at < 0 ? spec : spec.slice(0, at);
    const pattern = at < 0 ? null : new RegExp(spec.slice(at + 1), "u");
    let best = null;
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (!pattern) return element;
      const text = (element.getAttribute("aria-label") ?? "") + " " + (element.textContent ?? "");
      // With a text pattern the tightest match wins, so "*@^Worked for" finds the row, not <html>.
      if (pattern.test(text.trim()) && (!best || text.length < best.length)) best = { element, length: text.length };
    }
    return best?.element ?? null;
  };
  const font = (element) => {
    const style = getComputedStyle(element);
    return {
      family: style.fontFamily.split(",")[0].replaceAll('"', "").trim(),
      size: parseFloat(style.fontSize),
      weight: Number(style.fontWeight),
      lineHeight: style.lineHeight,
      transform: style.textTransform,
      letterSpacing: style.letterSpacing,
      color: style.color,
      background: style.backgroundColor,
      radius: style.borderTopLeftRadius,
      transition: style.transitionDuration === "0s" ? null : style.transitionProperty + " " + style.transitionDuration,
    };
  };
  const out = {};
  for (const [name, spec] of Object.entries(probes)) {
    const element = pick(spec);
    if (!element) { out[name] = null; continue; }
    const rect = element.getBoundingClientRect();
    // The first text-bearing descendant carries the type a reader sees.
    let textNode = element;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const first = walker.nextNode();
    if (first?.parentElement) textNode = first.parentElement;
    const svg = element.querySelector("svg");
    const svgRect = svg?.getBoundingClientRect();
    out[name] = {
      x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height),
      text: (element.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 80),
      box: font(element),
      type: font(textNode),
      icon: svgRect ? { w: round(svgRect.width), h: round(svgRect.height) } : null,
    };
  }
  // Running animations and transitions at the moment of capture, by name and duration.
  out.__animations = document.getAnimations().slice(0, 40).map((animation) => {
    const timing = animation.effect?.getTiming?.() ?? {};
    const target = animation.effect?.target;
    return {
      name: animation.animationName ?? animation.transitionProperty ?? animation.constructor.name,
      durationMs: typeof timing.duration === "number" ? timing.duration : null,
      iterations: timing.iterations === Infinity ? "infinite" : timing.iterations,
      target: target ? (target.getAttribute("data-testid") || target.className?.baseVal || target.className || target.tagName).toString().slice(0, 60) : null,
    };
  });
  out.__root = { fontSize: getComputedStyle(document.documentElement).fontSize, bodyFont: getComputedStyle(document.body).fontFamily.split(",")[0], bodySize: getComputedStyle(document.body).fontSize };
  return out;
}`;

/** What has focus now: tag, role, label and whether a visible focus ring is drawn. */
export const TAB_ORDER = `(() => {
  const element = document.activeElement;
  if (!element || element === document.body) return { tag: "body" };
  const style = getComputedStyle(element);
  const ring = (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || /(^|,)\\s*(rgb|oklch|oklab|#|color)/u.test(style.boxShadow) && style.boxShadow !== "none";
  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute("role"),
    label: (element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 50),
    ring,
    outline: style.outlineStyle === "none" ? null : style.outlineWidth + " " + style.outlineStyle + " " + style.outlineColor + " offset " + style.outlineOffset,
  };
})()`;
