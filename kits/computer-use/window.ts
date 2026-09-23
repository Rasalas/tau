import { WebContentsView, app, session, shell, systemPreferences, type DesktopCapturerSource } from "electron";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WindowExtension, WindowExtensionContext } from "tau/host-extension";
import type { ScreenAccess, ScreenLiveFrame } from "./protocol.js";

/** In memory only: the capture page keeps nothing. */
const CAPTURE_PARTITION = "tau-computer-use-screen";
const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const MAX_WIDTH = 1_280;

/**
 * Only macOS answers without asking: elsewhere a capture may raise the
 * system's own picker, so the live view stays off there.
 */
export function screenAccess(platform = process.platform, status = (): string => systemPreferences.getMediaAccessStatus("screen")): ScreenAccess {
  if (platform !== "darwin") return "unavailable";
  const answer = status();
  return answer === "granted" || answer === "denied" || answer === "not-determined" || answer === "restricted" ? answer : "unavailable";
}

/** The desktop-capture id of one window. There is deliberately no way to name a screen. */
export function windowSourceId(windowId: unknown): string {
  if (typeof windowId !== "number" || !Number.isInteger(windowId) || windowId <= 0) throw new Error("A live view records one window, named by its id.");
  return `window:${windowId}:0`;
}

/** `/Applications/Mail.app/Contents/MacOS/Mail` → `/Applications/Mail.app`. */
export function bundleOf(executable: string): string | undefined {
  const index = executable.indexOf(".app/");
  return index < 0 ? undefined : executable.slice(0, index + 4);
}

let capturePage: Promise<string> | undefined;
// `getDisplayMedia` needs a secure context, which `about:blank` is not; a file is.
const pageFile = (): Promise<string> => capturePage ??= (async () => {
  const directory = await mkdtemp(join(tmpdir(), "tau-screen-"));
  const file = join(directory, "screen.html");
  await writeFile(file, "<!doctype html><meta charset=\"utf-8\"><title>Tau screen</title>");
  return file;
})();

const START = `(async () => {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 4 }, audio: false });
  const video = document.createElement("video");
  video.muted = true;
  video.srcObject = stream;
  await video.play();
  const state = { seq: 0, ended: false, stream, video, canvas: document.createElement("canvas") };
  stream.getVideoTracks()[0]?.addEventListener("ended", () => { state.ended = true; });
  globalThis.__tauScreen = state;
  return true;
})()`;

// Drawn when asked, so a view that stops asking costs nothing.
const TAKE = `(() => {
  const state = globalThis.__tauScreen;
  if (!state) return null;
  if (state.ended) return { ended: true };
  const { video, canvas } = state;
  if (!video.videoWidth) return null;
  const scale = Math.min(1, ${MAX_WIDTH} / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return { seq: ++state.seq, url: canvas.toDataURL("image/jpeg", 0.72), width: canvas.width, height: canvas.height };
})()`;

const STOP = `(() => { globalThis.__tauScreen?.stream.getTracks().forEach((track) => track.stop()); globalThis.__tauScreen = undefined; })()`;

/**
 * Records one window to frames in a hidden page of its own: the session hands
 * that page the window's capture source and nothing else. It starts only once
 * the system already allows it, so it never raises the permission prompt.
 */
class WindowCapture {
  private view: WebContentsView | undefined;

  constructor(readonly windowId: number) {}

  async start(): Promise<void> {
    const source = windowSourceId(this.windowId);
    let armed = true;
    // The handler is the partition's: it answers this one request, then refuses.
    session.fromPartition(CAPTURE_PARTITION).setDisplayMediaRequestHandler((_request, callback) => {
      if (!armed) {
        callback({});
        return;
      }
      armed = false;
      callback({ video: { id: source, name: "Agent window" } as DesktopCapturerSource });
    });
    const view = new WebContentsView({
      webPreferences: { partition: CAPTURE_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.view = view;
    try {
      await view.webContents.loadFile(await pageFile());
      await view.webContents.executeJavaScript(START, true);
    } catch (error) {
      this.stop();
      throw error;
    } finally {
      armed = false;
    }
  }

  async take(): Promise<ScreenLiveFrame | { ended: true } | null> {
    const contents = this.view?.webContents;
    if (!contents || contents.isDestroyed()) return { ended: true };
    return await contents.executeJavaScript(TAKE) as ScreenLiveFrame | { ended: true } | null;
  }

  stop(): void {
    const contents = this.view?.webContents;
    this.view = undefined;
    if (!contents || contents.isDestroyed()) return;
    void contents.executeJavaScript(STOP).catch(() => undefined).finally(() => { if (!contents.isDestroyed()) contents.close(); });
  }
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
          const next = new WindowCapture(windowId);
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
