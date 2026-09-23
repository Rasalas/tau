import type { IpcMain, WebContents } from "electron";
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
import type { HostClientSink } from "./host-transport-clients.js";
import type { HostLogger } from "./host-log.js";

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
  /** The current workbench window. Recreated windows invalidate old senders. */
  workbenchContents(): WebContents | undefined;
  /** Where the window is reported as an attached client; without one nobody is counted. */
  clients?: HostClientSink;
  logger?: HostLogger;
  /** Delivers one push to the window, if there still is one. */
  send(channel: string, payload: unknown): void;
  /** Runs before every reply, so pushes still waiting to be coalesced reach the window first. */
  beforeReply?(): void;
  /** The window starts from a snapshot, not a replay: its first hello, or a resync. */
  onSnapshotClient?(): void;
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
  /** The client id of each window, by `WebContents` id; a reload says hello again. */
  const clientIds = new Map<number, string>();

  /**
   * The window is one client for as long as its `WebContents` lives: a reload
   * re-says hello on the same one, and the registry replaces it by that key.
   */
  const attach = (sender: WebContents, profile: string | undefined): void => {
    if (!options.clients) return;
    const key = `webcontents-${sender.id}`;
    const clientId = options.clients.attached({ transport: "electron", key, ...(profile ? { profile } : {}) });
    if (clientIds.has(sender.id)) { clientIds.set(sender.id, clientId); return; }
    clientIds.set(sender.id, clientId);
    sender.once("destroyed", () => {
      const current = clientIds.get(sender.id);
      clientIds.delete(sender.id);
      if (current !== undefined) options.clients?.detached(current);
    });
  };

  ipcMain.handle(HOST_REQUEST_CHANNEL, async (event, frame: unknown): Promise<HostResponse> => {
    const request = decodeHostRequest(frame);
    const workbench = options.workbenchContents();
    if (!workbench || workbench.isDestroyed() || event.sender !== workbench
      || event.senderFrame !== workbench.mainFrame) {
      options.logger?.warn("host-transport-electron.unauthorized", {
        senderId: event.sender.id, method: request?.method,
        reason: "not-current-workbench-main-frame",
      });
      return { id: request?.id ?? "", error: { message: "Only the workbench main frame may call the host.", code: HOST_ERROR.unauthorized } };
    }
    if (!request) return { id: "", error: { message: "Malformed request.", code: HOST_ERROR.invalidRequest } };
    try {
      if (request.method === "hello") {
        const hello = decodeHostHello(request.params[0]);
        if (!hello) return { id: request.id, error: { message: "Malformed hello.", code: HOST_ERROR.invalidRequest } };
        // After this reply is on its way: the push the attach publishes must
        // not reach the window before the sequence it starts counting from.
        setImmediate(() => { if (!event.sender.isDestroyed()) attach(event.sender, hello.profile); });
        options.beforeReply?.();
        const reply = helloReply(pushLog, hello, options);
        if (hello.lastSeq === undefined || reply.resync) options.onSnapshotClient?.();
        return { id: request.id, result: reply };
      }
      const result = await invokeHostMethod(methods, request.method, request.params);
      options.beforeReply?.();
      return { id: request.id, result };
    } catch (error) {
      // A failed method is a failed request, never a broken channel.
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : HOST_ERROR.failed;
      options.beforeReply?.();
      return { id: request.id, error: hostErrorInfo(error, code) };
    }
  });

  return {
    deliver: (push) => options.send(HOST_EVENT_CHANNEL, push),
  };
}
