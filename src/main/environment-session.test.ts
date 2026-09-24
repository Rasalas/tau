import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import { installEnvironmentSession, withoutOrigin } from "./environment-session.js";

describe("the page's session and the saved machines", () => {
  it("drops the page's Origin only on its own sockets to a saved machine", () => {
    let beforeSend: ((details: { url: string; webContentsId?: number; requestHeaders: Record<string, string> }, callback: (response: unknown) => void) => void) | undefined;
    const session = {
      setCertificateVerifyProc: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn((_filter: unknown, listener: typeof beforeSend) => { beforeSend = listener; }) },
    } as unknown as Session;
    installEnvironmentSession(session, { certificateVerdict: () => -3, isSavedSocket: (url) => url.startsWith("wss://studio") }, () => 7);
    const headers = { Origin: "file://", "Sec-WebSocket-Key": "k" };
    const answer = (url: string, webContentsId: number | undefined) => {
      let response: unknown;
      beforeSend!({ url, webContentsId, requestHeaders: headers }, (value) => { response = value; });
      return response;
    };
    expect(answer("wss://studio:7788/", 7)).toEqual({ requestHeaders: { "Sec-WebSocket-Key": "k" } });
    expect(answer("wss://studio:7788/", 8)).toEqual({});
    expect(answer("ws://127.0.0.1:5000/", 7)).toEqual({});
    expect(withoutOrigin({ origin: "x", Host: "h" })).toEqual({ Host: "h" });
  });
});
