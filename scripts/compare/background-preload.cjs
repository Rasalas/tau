// Required into T3 Code's Electron main process through NODE_OPTIONS (see apps.mjs): the same
// no-focus rules as Tau's TAU_NO_FOCUS, without touching T3's checkout. Only the main process acts.
if (process.type === "browser") {
  // Children (T3's server, the codex stand-in) start without the preload.
  delete process.env.NODE_OPTIONS;
  // Preloads run before Electron's own init; its modules exist once the main script has started.
  setImmediate(() => {
    const { app, BaseWindow } = require("electron");
    if (process.platform === "darwin") app.setActivationPolicy("accessory");
    app.focus = () => undefined;
    BaseWindow.prototype.show = function show() { this.showInactive(); };
    BaseWindow.prototype.focus = () => undefined;
  });
}
