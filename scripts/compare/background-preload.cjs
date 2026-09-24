// Required into T3 Code's Electron main process through NODE_OPTIONS (see apps.mjs): the same
// no-focus rules as Tau's TAU_NO_FOCUS, without touching T3's checkout. Only the main process acts.
if (process.type === "browser") {
  // Children (T3's server, the codex stand-in) start without the preload.
  delete process.env.NODE_OPTIONS;
  // Preloads run before Electron's own init; the first `require("electron")` that has an `app` is the earliest point.
  const Module = require("node:module");
  const load = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    const loaded = load.call(this, request, ...rest);
    if (request === "electron" && loaded?.app) {
      Module._load = load;
      const { app, BaseWindow } = loaded;
      if (process.platform === "darwin") app.setActivationPolicy("accessory");
      app.focus = () => undefined;
      BaseWindow.prototype.show = function show() { this.showInactive(); };
      BaseWindow.prototype.focus = () => undefined;
    }
    return loaded;
  };
}
