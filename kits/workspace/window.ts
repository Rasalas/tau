import { app, BrowserWindow } from "electron";
import type { WindowExtension, WindowExtensionContext } from "tau/host-extension";

/** The workbench window: visible or minimized, never a hidden helper page. */
function workbenchWindow(): BrowserWindow | undefined {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
  return windows.find((window) => window.isVisible() || window.isMinimized()) ?? windows[0];
}

/**
 * Workspace Kit's half in the window's process: it brings the window to the
 * front when `tau app` opened a folder from a terminal.
 */
export default function activate(_context: WindowExtensionContext): WindowExtension {
  return {
    handle(command) {
      if (command !== "focus") throw new Error(`Workspace Kit's window half has no command "${command}".`);
      const window = workbenchWindow();
      if (!window) return false;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      // The request came from another app's terminal; macOS only raises a window of the active app.
      if (process.platform === "darwin") app.focus({ steal: true });
      return true;
    },
  };
}
