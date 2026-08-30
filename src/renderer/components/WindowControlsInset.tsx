/**
 * macOS draws the real traffic lights over the title bar (titleBarStyle
 * "hiddenInset"), so the bar only has to keep that corner clear. Everywhere else
 * — other platforms, and the browser preview — there is nothing to make room for.
 */
export function WindowControlsInset() {
  if (window.tau?.platform !== "darwin") return null;
  return <div className="window-controls-inset" aria-hidden />;
}
