import type { IpcMain } from "electron";
import {
  HOST_ERROR,
  decodeHostHello,
  decodeHostRequest,
  hostErrorInfo,
  type HostPush,
  type HostResponse,
} from "../shared/host-transport.js";
import { helloReply, type HostPushLog } from "./host-push-log.js";
import { invokeHostMethod, type HostMethodTable } from "./host-methods.js";

/** The renderer invokes exactly this channel; every method travels inside the frame. */
export const HOST_REQUEST_CHANNEL = "tau:request";
/** The one push channel, main → renderer. */
export const HOST_EVENT_CHANNEL = "tau:host-event";

export interface ElectronHostTransportOptions {
  ipcMain: IpcMain;
  methods: HostMethodTable;
  pushLog: HostPushLog;
  hostVersion: string;
  capabilities: string[];
  /** Delivers one push to the window, if there still is one. */
  send(channel: string, payload: unknown): void;
}

export interface ElectronHostTransport {
  /** Sends one already-numbered push to the window, if there still is one. */
  deliver(push: HostPush): void;
}

/**
 * Electron IPC as one transport of the host protocol: a single invoke channel
 * dispatching into the method table, and a single push channel carrying `seq`.
 */
export function installElectronHostTransport(options: ElectronHostTransportOptions): ElectronHostTransport {
  const { ipcMain, methods, pushLog } = options;

  ipcMain.handle(HOST_REQUEST_CHANNEL, async (_event, frame: unknown): Promise<HostResponse> => {
    const request = decodeHostRequest(frame);
    if (!request) return { id: "", error: { message: "Malformed request.", code: HOST_ERROR.invalidRequest } };
    try {
      if (request.method === "hello") {
        const hello = decodeHostHello(request.params[0]);
        if (!hello) return { id: request.id, error: { message: "Malformed hello.", code: HOST_ERROR.invalidRequest } };
        return { id: request.id, result: helloReply(pushLog, hello, options) };
      }
      return { id: request.id, result: await invokeHostMethod(methods, request.method, request.params) };
    } catch (error) {
      // A failed method is a failed request, never a broken channel.
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : HOST_ERROR.failed;
      return { id: request.id, error: hostErrorInfo(error, code) };
    }
  });

  return {
    deliver: (push) => options.send(HOST_EVENT_CHANNEL, push),
  };
}
