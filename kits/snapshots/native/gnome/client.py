"""Bounded, no-eval D-Bus transport for Tau's explicitly enabled Shell extension."""
import json
import os
import sys
from gi.repository import Gio, GLib

NAME = "de.tbuck.Tau.SnapShots"
PATH = "/de/tbuck/Tau/SnapShots"
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
if sys.argv[1] == "check":
    answer = bus.call_sync(NAME, PATH, "org.freedesktop.DBus.Properties", "Get",
                           GLib.Variant("(ss)", (NAME, "Version")), GLib.VariantType("(v)"),
                           Gio.DBusCallFlags.NO_AUTO_START, 3000, None)
    print(json.dumps({"version": answer.unpack()[0]}))
elif sys.argv[1] == "capture" and len(sys.argv) == 3:
    owned = bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
                         GLib.Variant("(su)", ("de.tbuck.Tau.SnapShotClient", 4)), GLib.VariantType("(u)"),
                         Gio.DBusCallFlags.NONE, 3000, None).unpack()[0]
    if owned not in (1, 4):
        raise RuntimeError("Another capture client is busy.")
    png, metadata = bus.call_sync(NAME, PATH, NAME, "Capture", None, GLib.VariantType("(ays)"),
                                 Gio.DBusCallFlags.NO_AUTO_START, 20000, None).unpack()
    if len(png) > 16 * 1024 * 1024:
        raise RuntimeError("The window image is too large.")
    descriptor = os.open(os.path.join(sys.argv[2], "capture.png"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as image:
        image.write(bytes(png))
    print(json.dumps(json.loads(metadata)))
else:
    raise RuntimeError("Expected check or capture <private directory>.")
