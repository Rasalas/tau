import { contextBridge, ipcRenderer, webFrame } from "electron";
import type { TauDesktopApi } from "../shared/contracts.js";
import { HOST_ERROR, decodeHostPush, decodeHostResponse, type HostResponse } from "../shared/host-transport.js";

/** The two channels of the Electron transport; method names travel inside the frames. */
const REQUEST_CHANNEL = "tau:request";
const EVENT_CHANNEL = "tau:host-event";

let counter = 0;

const api: TauDesktopApi = {
  platform: process.platform,
  request: async (method, params) => {
    counter += 1;
    const raw: unknown = await ipcRenderer.invoke(REQUEST_CHANNEL, { id: `r${counter}`, method, params });
    const response = decodeHostResponse(raw);
    // A main process that answers with something else is a bug, not a result.
    return response ?? ({ id: "", error: { message: `Malformed response for ${method}.`, code: HOST_ERROR.invalidRequest } } satisfies HostResponse);
  },
  onHostEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      // IPC payloads are untrusted. In particular, never let a contradictory
      // cursor/hasMore/completeness tuple enter the renderer state machine.
      const push = decodeHostPush(payload);
      if (push) listener(push);
    };
    ipcRenderer.on(EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("tau", api);

// Zooming fires `resize`; the title bar's traffic-light inset divides by this.
const publishZoom = () => document.documentElement.style.setProperty("--page-zoom", String(webFrame.getZoomFactor()));
window.addEventListener("DOMContentLoaded", publishZoom, { once: true });
window.addEventListener("resize", publishZoom);
