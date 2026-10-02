import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { CaptureService } from "./capture-service.js";

const NAME = "de.tbuck.Tau.SnapShots";
const CLIENT = "de.tbuck.Tau.SnapShotClient";
const XML = `<node><interface name="${NAME}">
  <property name="Version" type="u" access="read"/>
  <method name="Capture"><arg type="ay" direction="out"/><arg type="s" direction="out"/></method>
</interface></node>`;

function owner() {
  return new Promise((resolve, reject) => {
    Gio.DBus.session.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetNameOwner",
      new GLib.Variant("(s)", [CLIENT]), new GLib.VariantType("(s)"), Gio.DBusCallFlags.NONE, 3000, null,
      (connection, result) => { try { resolve(connection.call_finish(result).deepUnpack()[0]); } catch (error) { reject(error); } });
  });
}

export default class SnapShots extends Extension {
  enable() {
    this.captureService = new CaptureService({ available: () => !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter &&
      (typeof Meta.is_wayland_compositor !== "function" || Meta.is_wayland_compositor()), owner, take: () => this.takeWindow() });
    this.busObject = Gio.DBusExportedObject.wrapJSObject(XML, this);
    this.busObject.export(Gio.DBus.session, "/de/tbuck/Tau/SnapShots");
    this.busOwner = Gio.bus_own_name_on_connection(Gio.DBus.session, NAME, Gio.BusNameOwnerFlags.NONE, null, null);
  }

  get Version() { return 1; }

  CaptureAsync(_parameters, invocation) {
    void this.captureService.capture(invocation.get_sender()).then(({ png, metadata }) => {
      invocation.return_value(new GLib.Variant("(ays)", [png, JSON.stringify(metadata)]));
    }).catch((error) => invocation.return_dbus_error(`${NAME}.Failed`, error.message));
  }

  async takeWindow() {
    // Reading identity and beginning capture are one synchronous operation.
    const window = global.display.focus_window;
    if (!window || window.minimized || !window.get_compositor_private()) throw new Error("No focused window is available.");
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    const frame = window.get_frame_rect();
    const buffer = window.get_buffer_rect();
    const metadata = { title: window.get_title() ?? "", appName: app?.get_name() ?? "Application", processId: Math.max(0, window.get_pid()),
      bounds: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      bufferBounds: { x: buffer.x, y: buffer.y, width: buffer.width, height: buffer.height } };
    const stream = Gio.MemoryOutputStream.new_resizable();
    try {
      const screenshot = new Shell.Screenshot();
      await new Promise((resolve, reject) => screenshot.screenshot_window(true, false, stream, (source, result) => {
        try { const [success] = source.screenshot_window_finish(result); if (!success) throw new Error("GNOME returned no window image."); resolve(); } catch (error) { reject(error); }
      }));
      stream.close(null);
      if (stream.get_data_size() > 16 * 1024 * 1024) throw new Error("The window image is too large.");
      const after = window.get_frame_rect();
      const afterBuffer = window.get_buffer_rect();
      const unchanged = window.get_title() === metadata.title && window.get_pid() === metadata.processId &&
        after.x === frame.x && after.y === frame.y && after.width === frame.width && after.height === frame.height &&
        afterBuffer.x === buffer.x && afterBuffer.y === buffer.y && afterBuffer.width === buffer.width && afterBuffer.height === buffer.height;
      return { png: stream.steal_as_bytes().get_data(), metadata: { window: unchanged ? metadata : null } };
    } finally { if (!stream.is_closed()) stream.close(null); }
  }

  disable() {
    this.captureService?.disable();
    this.busObject?.unexport();
    if (this.busOwner) Gio.bus_unown_name(this.busOwner);
    this.busObject = null;
    this.busOwner = 0;
  }
}
