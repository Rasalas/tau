/**
 * Test instances, smokes and benchmarks set `TAU_NO_FOCUS=1` so their windows never take focus from
 * the user's app; `TAU_FOREGROUND=1` overrides it. The installed app sets neither.
 */
export function backgroundModeRequested(env: NodeJS.ProcessEnv): boolean {
  return env.TAU_NO_FOCUS === "1" && env.TAU_FOREGROUND !== "1";
}

export interface BackgroundApp {
  setActivationPolicy?(policy: "regular" | "accessory" | "prohibited"): void;
  focus(options?: { steal: boolean }): void;
}

/** The part of Electron's `BaseWindow.prototype` that activates the app. */
export interface BackgroundWindowPrototype {
  show(): void;
  showInactive(): void;
  focus(): void;
}

/**
 * No Dock icon and no activation on macOS. Patched on the prototype because kits' window halves call
 * `show`, `focus` and `app.focus` themselves; windows still show and paint, only inactive.
 */
export function installBackgroundMode(app: BackgroundApp, windowPrototype: BackgroundWindowPrototype, platform: NodeJS.Platform = process.platform): void {
  if (platform === "darwin") app.setActivationPolicy?.("accessory");
  app.focus = () => undefined;
  windowPrototype.show = function show(this: BackgroundWindowPrototype) { this.showInactive(); };
  windowPrototype.focus = () => undefined;
}
