export const LIST_PAINT_MARK = "tau.mobile.list-painted";

/** Runs before React mounts, only in the virtual device's development build. */
export function observeListPaint(): void {
  let pending = false;
  const visible = (element: HTMLElement): boolean => {
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const x = Math.max(0, Math.min(innerWidth - 1, box.left + box.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, box.top + box.height / 2));
    return box.bottom > 0 && box.top < innerHeight && element.contains(document.elementFromPoint(x, y));
  };
  const ready = () => document.visibilityState === "visible" && !document.querySelector(".host-connection-status") && [...document.querySelectorAll<HTMLButtonElement>(".touch-browser.home .touch-thread-open")].some((row) => !row.disabled && visible(row));
  const check = () => {
    if (pending || !ready()) return;
    pending = true;
    observer.disconnect();
    requestAnimationFrame(() => setTimeout(() => {
      if (ready()) performance.mark(LIST_PAINT_MARK);
      else {
        pending = false;
        observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      }
    }, 0));
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  check();
}
