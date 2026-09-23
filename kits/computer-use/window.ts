import { app, shell, systemPreferences } from "electron";
import { execFile } from "node:child_process";
import type { WindowExtension, WindowExtensionContext } from "tau/host-extension";
import { WindowCapture, windowSourceId, type WindowCaptureOptions } from "../_window-capture/capture.js";
import type { ScreenAccess, ScreenLiveFrame } from "./protocol.js";

const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
/** In memory only: the capture page keeps nothing. */
const LIVE: WindowCaptureOptions = { partition: "tau-computer-use-screen", maxWidth: 1_280, mimeType: "image/jpeg", quality: 0.72, frameRate: 4 };

/**
 * Only macOS answers without asking: elsewhere a capture may raise the
 * system's own picker, so the live view stays off there.
 */
export function screenAccess(platform = process.platform, status = (): string => systemPreferences.getMediaAccessStatus("screen")): ScreenAccess {
  if (platform !== "darwin") return "unavailable";
  const answer = status();
  return answer === "granted" || answer === "denied" || answer === "not-determined" || answer === "restricted" ? answer : "unavailable";
}

/** `/Applications/Mail.app/Contents/MacOS/Mail` → `/Applications/Mail.app`. */
export function bundleOf(executable: string): string | undefined {
  const index = executable.indexOf(".app/");
  return index < 0 ? undefined : executable.slice(0, index + 4);
}

function executableOf(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 2_000 }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
}

const pidOf = (input: unknown): number => {
  const pid = (input as { pid?: unknown } | undefined)?.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) throw new Error("No process to look at.");
  return pid;
};

const windowIdOf = (input: unknown): number => {
  const windowId = (input as { windowId?: unknown } | undefined)?.windowId;
  windowSourceId(windowId);
  return windowId as number;
};

/** Computer Use's window half: the live view of one window, the app's icon, the privacy pane. */
export default function activate(_context: WindowExtensionContext): WindowExtension {
  let capture: WindowCapture | undefined;
  const stop = (): void => {
    capture?.stop();
    capture = undefined;
  };
  return {
    async handle(command: string, input?: unknown): Promise<unknown> {
      switch (command) {
        case "access":
          return screenAccess();
        case "open-settings":
          if (process.platform === "darwin") await shell.openExternal(SCREEN_RECORDING_SETTINGS);
          return undefined;
        case "icon": {
          if (process.platform !== "darwin") return null;
          const bundle = bundleOf(await executableOf(pidOf(input)) ?? "");
          if (!bundle) return null;
          const icon = await app.getFileIcon(bundle, { size: "normal" });
          return icon.isEmpty() ? null : icon.toDataURL();
        }
        case "live-start": {
          const windowId = windowIdOf(input);
          const access = screenAccess();
          if (access !== "granted") return access;
          if (capture?.windowId === windowId) return access;
          stop();
          const next = new WindowCapture(windowId, LIVE);
          capture = next;
          try {
            await next.start();
          } catch (error) {
            if (capture === next) capture = undefined;
            throw error;
          }
          return access;
        }
        case "live-frame": {
          const windowId = windowIdOf(input);
          if (!capture || capture.windowId !== windowId) return { ended: true };
          return capture.take();
        }
        case "live-stop": {
          // A late stop for the window before must not end the one that replaced it.
          const windowId = (input as { windowId?: unknown } | undefined)?.windowId;
          if (windowId === undefined || capture?.windowId === windowId) stop();
          return undefined;
        }
        default:
          throw new Error(`Computer Use's window half has no command "${command}".`);
      }
    },
    dispose: stop,
  };
}
