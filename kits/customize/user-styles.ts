import type { UserStyle } from "./protocol.js";

/**
 * The user's styles as one `<style>` per entry at the end of `<head>`, after
 * every extension's sheet, so a rule of the same weight wins. A sheet added
 * later (an extension turned on) moves them back to the end.
 */
export function mountUserStyles(): { set(styles: readonly UserStyle[]): void; dispose(): void } {
  const elements = new Map<string, HTMLStyleElement>();
  let order: HTMLStyleElement[] = [];
  const toEnd = () => {
    if (order.length === 0 || document.head.lastElementChild === order.at(-1)) return;
    for (const element of order) document.head.append(element);
  };
  const observer = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(toEnd);
  observer?.observe(document.head, { childList: true });
  return {
    set(styles) {
      const wanted = styles.filter((style) => style.enabled);
      for (const [id, element] of elements) {
        if (!wanted.some((style) => style.id === id)) { element.remove(); elements.delete(id); }
      }
      for (const style of wanted) {
        let element = elements.get(style.id);
        if (!element) {
          element = document.createElement("style");
          element.dataset.tauUserStyle = style.id;
          elements.set(style.id, element);
        }
        if (element.textContent !== style.css) element.textContent = style.css;
      }
      // In the list's order, so a later style wins.
      order = wanted.map((style) => elements.get(style.id)!);
      for (const element of order) document.head.append(element);
    },
    dispose() {
      observer?.disconnect();
      for (const element of elements.values()) element.remove();
      elements.clear();
      order = [];
    },
  };
}
