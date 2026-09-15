import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { HOST_ERROR, HOST_TRANSPORT_VERSION, type HostResponse } from "../shared/host-transport.js";
import { HostPushLog } from "./host-push-log.js";
import { HOST_REQUEST_CHANNEL, installElectronHostTransport } from "./host-transport-electron.js";

function contents() {
  return { id: 42, mainFrame: {}, isDestroyed: vi.fn(() => false) } as unknown as WebContents;
}

function fixture() {
  const current = { value: contents() as WebContents | undefined };
  let invoke!: (event: IpcMainInvokeEvent, frame: unknown) => Promise<HostResponse>;
  const ping = vi.fn(async () => "pong");
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handle = vi.fn((channel: string, handler: typeof invoke) => {
    expect(channel).toBe(HOST_REQUEST_CHANNEL);
    invoke = handler;
  });
  installElectronHostTransport({
    ipcMain: { handle } as unknown as IpcMain,
    methods: { ping }, pushLog: new HostPushLog(), hostVersion: "test", capabilities: [],
    workbenchContents: () => current.value,
    logger,
    send: () => undefined,
  });
  const event = (sender: WebContents, senderFrame: IpcMainInvokeEvent["senderFrame"] = sender.mainFrame) =>
    ({ sender, senderFrame }) as IpcMainInvokeEvent;
  const request = { id: "request-1", method: "ping", params: [] };
  return { current, event, invoke, ping, request, logger };
}

describe("Electron host caller provenance", () => {
  it("dispatches from the current workbench main frame", async () => {
    const h = fixture();
    expect(await h.invoke(h.event(h.current.value!), h.request)).toEqual({ id: "request-1", result: "pong" });
    expect(h.ping).toHaveBeenCalledOnce();
  });

  it("rejects foreign contents even when request data claims a trusted caller", async () => {
    const h = fixture();
    const result = await h.invoke(h.event(contents()), {
      ...h.request, callerId: "workbench", params: [{ callerId: "tau.workspace" }],
    });
    expect(result.error?.code).toBe(HOST_ERROR.unauthorized);
    expect(h.ping).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith("host-transport-electron.unauthorized", {
      senderId: 42, method: "ping", reason: "not-current-workbench-main-frame",
    });
  });

  it("rejects subframes and detached frames before exposing hello state", async () => {
    const h = fixture();
    for (const frame of [null, contents().mainFrame]) {
      const result = await h.invoke(h.event(h.current.value!, frame), {
        id: "hello", method: "hello", params: [{ protocol: HOST_TRANSPORT_VERSION }],
      });
      expect(result.error?.code).toBe(HOST_ERROR.unauthorized);
      expect(result.result).toBeUndefined();
    }
    expect(h.ping).not.toHaveBeenCalled();
  });

  it("revokes old and destroyed windows while allowing a replacement", async () => {
    const h = fixture();
    const old = h.current.value!;
    h.current.value = contents();
    expect((await h.invoke(h.event(old), h.request)).error?.code).toBe(HOST_ERROR.unauthorized);
    expect((await h.invoke(h.event(h.current.value), h.request)).result).toBe("pong");
    vi.mocked(h.current.value.isDestroyed).mockReturnValue(true);
    expect((await h.invoke(h.event(h.current.value), h.request)).error?.code).toBe(HOST_ERROR.unauthorized);
    h.current.value = undefined;
    expect((await h.invoke(h.event(old), h.request)).error?.code).toBe(HOST_ERROR.unauthorized);
    expect(h.ping).toHaveBeenCalledOnce();
  });
});
