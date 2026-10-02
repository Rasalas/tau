import { join } from "node:path";
import { appIdentity, type AppIdentity as AppNames } from "./app-identity.js";

export interface AppIdentity {
  getPath(name: "appData"): string;
  setPath(name: "userData", path: string): void;
  setName(name: string): void;
  setAppUserModelId?(id: string): void;
}

/**
 * Names the app and its userData (the app identity's folder, or `TAU_USER_DATA`
 * for an isolated instance), which also gives it its own lock and preferences.
 * Windows shows a toast only for an app whose AppUserModelID matches a shortcut's.
 */
export function configureAppIdentity(app: AppIdentity, userData?: string, platform: NodeJS.Platform = process.platform, identity: AppNames = appIdentity()): void {
  app.setPath("userData", userData || join(app.getPath("appData"), identity.userDataFolder));
  app.setName(identity.productName);
  if (platform === "win32") app.setAppUserModelId?.(identity.appId);
}

export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance", listener: () => void): unknown;
}

export interface SingleInstanceWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

/**
 * Keeps one desktop app alive and brings its window forward on later starts.
 * Starting Tau again while it has no window opens one: the host kept running
 * without it, so the window is the only thing missing (ADR 0021).
 */
export function installSingleInstance(
  app: SingleInstanceApp,
  currentWindow: () => SingleInstanceWindow | undefined,
  openWindow?: () => void,
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }
  app.on("second-instance", () => {
    const window = currentWindow();
    if (!window || window.isDestroyed()) {
      openWindow?.();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
