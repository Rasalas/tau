// Finds elements by visible text or label and clicks them with real input events.
import { click, evaluate, waitFor } from "./cdp.mjs";

/**
 * An expression yielding the centre of the first visible `selector` whose text or aria-label matches.
 * A match below the fold is scrolled into view first: a click outside the viewport lands nowhere.
 */
export function locate(selector, pattern) {
  return `(() => {
    const pattern = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
    for (const element of document.querySelectorAll(${JSON.stringify(selector)})) {
      const label = [element.getAttribute("aria-label"), element.textContent].filter(Boolean).join(" ").replace(/\\s+/g, " ").trim();
      if (!pattern.test(label)) continue;
      if (element.disabled || element.getAttribute("aria-disabled") === "true") continue;
      let rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.top < 0 || rect.bottom > innerHeight || rect.left < 0 || rect.right > innerWidth) {
        element.scrollIntoView({ block: "nearest", inline: "nearest" });
        rect = element.getBoundingClientRect();
      }
      let x = rect.left + rect.width / 2;
      let y = rect.top + rect.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
      // Scrolled to the edge of a list, a match can sit under the list's sticky header.
      const covered = () => {
        const hit = document.elementFromPoint?.(x, y);
        return hit !== undefined && hit !== null && hit !== element && !element.contains(hit);
      };
      if (covered()) {
        element.scrollIntoView({ block: "center", inline: "nearest" });
        rect = element.getBoundingClientRect();
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
        if (covered()) return null;
      }
      return { x, y, label: label.slice(0, 120) };
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

/** What a dialog shows, for an error when the step the harness waits for never comes. */
export function describeDialog(selector) {
  return `(() => {
    const dialog = document.querySelector(${JSON.stringify(selector)});
    const text = (element) => element.textContent.replace(/\\s+/g, " ").trim();
    if (!dialog) return "no " + ${JSON.stringify(selector)} + "; the page reads " + JSON.stringify(text(document.body).slice(0, 300));
    const headings = [...dialog.querySelectorAll("h1, h2, h3")].map(text);
    const buttons = [...dialog.querySelectorAll("button")].map((button) => text(button) + (button.disabled ? " (disabled)" : ""));
    return "headings " + JSON.stringify(headings) + ", buttons " + JSON.stringify(buttons);
  })()`;
}

/** `waitFor`, but a timeout also says what `selector` shows at that moment. */
export async function waitForStep(session, expression, selector, { timeoutMs = 60_000 } = {}) {
  try {
    return await waitFor(session, expression, { timeoutMs });
  } catch (error) {
    const shows = await evaluate(session, describeDialog(selector)).catch((cause) => `unreadable: ${cause.message}`);
    throw new Error(`${error.message}\nThe page shows: ${shows}`, { cause: error });
  }
}
