import type { LinkTarget } from "./settings.js";

/** Web links follow the setting; ⌘, Ctrl and Alt/Option always select the system browser. */
export function resolveLinkTarget(url: string, event: { metaKey: boolean; ctrlKey: boolean; altKey?: boolean }, preference: LinkTarget): LinkTarget {
  if (preference !== "app" || event.metaKey || event.ctrlKey || event.altKey) return "system";
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? "app" : "system";
  } catch {
    return "system";
  }
}

/** Links in rendered Markdown: the transcript and every other place core draws a reply. */
const LINK_SELECTOR = ".markdown a[href]";

/** Routes reply links to the Preview, and Alt/Option clicks explicitly to the system browser. */
export function followLinkTarget(read: () => LinkTarget, open: (url: string) => void, openExternal: (url: string) => void, root: Document = document): () => void {
  const click = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>(LINK_SELECTOR) : null;
    if (!anchor) return;
    if (event.altKey) {
      // Chromium downloads an Alt-click unless the default action is cancelled.
      event.preventDefault();
      openExternal(anchor.href);
      return;
    }
    if (resolveLinkTarget(anchor.href, event, read()) !== "app") return;
    event.preventDefault();
    open(anchor.href);
  };
  root.addEventListener("click", click, true);
  return () => root.removeEventListener("click", click, true);
}
