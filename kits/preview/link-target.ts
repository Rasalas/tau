import type { LinkTarget } from "./settings.js";

/**
 * Where a click on a link resolves to. `app` only when the setting asks for
 * it, the URL is a web page and no ⌘ or Ctrl was held: the modifier is the
 * one-gesture way to the system browser.
 */
export function resolveLinkTarget(url: string, event: { metaKey: boolean; ctrlKey: boolean }, preference: LinkTarget): LinkTarget {
  if (preference !== "app" || event.metaKey || event.ctrlKey) return "system";
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? "app" : "system";
  } catch {
    return "system";
  }
}

/** Links in rendered Markdown: the transcript and every other place core draws a reply. */
const LINK_SELECTOR = ".markdown a[href]";

/**
 * Sends a plain click on a link in a reply to the Preview when the setting
 * says so; everything else — a modifier, another button, another scheme —
 * keeps the link's own way out to the system browser.
 */
export function followLinkTarget(read: () => LinkTarget, open: (url: string) => void, root: Document = document): () => void {
  const click = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(LINK_SELECTOR) : null;
    if (!anchor) return;
    if (resolveLinkTarget(anchor.href, event, read()) !== "app") return;
    event.preventDefault();
    open(anchor.href);
  };
  root.addEventListener("click", click, true);
  return () => root.removeEventListener("click", click, true);
}
