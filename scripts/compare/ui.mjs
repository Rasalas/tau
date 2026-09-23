// Finds elements by visible text or label and clicks them with real input events.
import { click, evaluate, waitFor } from "./cdp.mjs";

/** An expression yielding the centre of the first visible `selector` whose text or aria-label matches. */
export function locate(selector, pattern) {
  return `(() => {
    const pattern = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
    for (const element of document.querySelectorAll(${JSON.stringify(selector)})) {
      const label = [element.getAttribute("aria-label"), element.textContent].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      if (!pattern.test(label)) continue;
      if (element.disabled || element.getAttribute("aria-disabled") === "true") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, label: label.slice(0, 120) };
    }
    return null;
  })()`;
}

export async function clickWhenReady(session, selector, pattern, { timeoutMs = 30_000 } = {}) {
  const { value } = await waitFor(session, locate(selector, pattern), { timeoutMs });
  await click(session, value.x, value.y);
  return value.label;
}

export async function textPresent(session, text) {
  return evaluate(session, `document.body.textContent.includes(${JSON.stringify(text)})`);
}
