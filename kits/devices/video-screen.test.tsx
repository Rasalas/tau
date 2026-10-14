// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import VideoDeviceScreen from "./video-screen.js";
import type { VideoBatch } from "./stream-protocol.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const target = { hostId: "local", deviceId: "sim" };

it("reports native frame dimension changes and closes its lease when the document hides", async () => {
  const drawImage = vi.fn(), closeFrame = vi.fn(), closeDecoder = vi.fn();
  let decoded = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("EncodedVideoChunk", class { constructor(readonly init: EncodedVideoChunkInit) {} });
  vi.stubGlobal("VideoDecoder", class {
    static isConfigSupported = async () => ({ supported: true });
    state = "unconfigured"; decodeQueueSize = 0;
    constructor(readonly init: VideoDecoderInit) {}
    configure() { this.state = "configured"; }
    decode() { decoded++; this.init.output({ displayWidth: decoded === 1 ? 640 : 1280, displayHeight: decoded === 1 ? 1280 : 640, close: closeFrame } as unknown as VideoFrame); }
    close() { this.state = "closed"; closeDecoder(); }
  });
  const batch: VideoBatch = { packets: [{ kind: "config", codec: "avc1.42001e", data: "AUIAHg==", timestamp: 0 }, { kind: "key", data: "AAABZQ==", timestamp: 16_667 }, { kind: "key", data: "AAABZQ==", timestamp: 33_334 }] };
  let sent = false;
  const invoke = vi.fn(async (command: string, _input?: unknown): Promise<unknown> => {
    if (command === "stream-open") return { id: "lease" };
    if (command === "stream-read") {
      if (!sent) { sent = true; return batch; }
      return new Promise<unknown>(() => undefined);
    }
    return undefined;
  });
  const request = <T,>(command: string, input?: unknown): Promise<T> => invoke(command, input) as Promise<T>;
  const dimensions: number[][] = [];
  const onCanvas = vi.fn((canvas: HTMLCanvasElement | undefined) => { if (canvas) dimensions.push([canvas.width, canvas.height]); }), onFallback = vi.fn();
  render(<VideoDeviceScreen target={target} invoke={request} name="Phone" onCanvas={onCanvas} onFallback={onFallback} />);
  await waitFor(() => expect(drawImage).toHaveBeenCalled());
  const surface = onCanvas.mock.calls[0][0] as HTMLCanvasElement;
  expect([surface.width, surface.height]).toEqual([1280, 640]);
  expect(dimensions).toEqual([[640, 1280], [1280, 640]]);
  expect(closeFrame).toHaveBeenCalled();
  expect(onFallback).not.toHaveBeenCalled();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream-close", { id: "lease" }));
  expect(closeDecoder).toHaveBeenCalled();
});

it("reports capture fallback without starting a video lease when WebCodecs is unavailable", async () => {
  vi.stubGlobal("VideoDecoder", undefined);
  const invoke = vi.fn(), onFallback = vi.fn();
  render(<VideoDeviceScreen target={target} invoke={invoke} name="Phone" onCanvas={vi.fn()} onFallback={onFallback} />);
  await waitFor(() => expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(/Showing screen captures/u)));
  expect(invoke).not.toHaveBeenCalled();
});

const config: VideoBatch["packets"][number] = { kind: "config", codec: "avc1.42001e", data: "AUIAHg==", timestamp: 0 };
const key: VideoBatch["packets"][number] = { kind: "key", data: "AAABZQ==", timestamp: 16_667 };

function videoFixture(closeLease?: () => Promise<unknown>) {
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("EncodedVideoChunk", class { constructor(readonly init: EncodedVideoChunkInit) {} });
  const decoders: Decoder[] = [];
  class Decoder {
    static isConfigSupported = async () => ({ supported: true });
    state = "unconfigured"; decodeQueueSize = 0;
    configure = vi.fn(() => { this.state = "configured"; });
    decode = vi.fn();
    close = vi.fn(() => { this.state = "closed"; });
    constructor(readonly init: VideoDecoderInit) { decoders.push(this); }
  }
  vi.stubGlobal("VideoDecoder", Decoder);
  const reads = new Map<string, (batch: VideoBatch) => void>();
  let opened = 0;
  const invoke = vi.fn(async (command: string, input?: unknown): Promise<unknown> => {
    if (command === "stream-open") return { id: `lease-${++opened}` };
    if (command === "stream-read") return new Promise<VideoBatch>((resolve) => reads.set((input as { id: string }).id, resolve));
    if (command === "stream-close") return closeLease?.();
    return undefined;
  });
  const request = <T,>(command: string, input?: unknown): Promise<T> => invoke(command, input) as Promise<T>;
  const onCanvas = vi.fn(), onFallback = vi.fn();
  const view = render(<VideoDeviceScreen target={target} invoke={request} name="Phone" onCanvas={onCanvas} onFallback={onFallback} />);
  const send = async (id: string, packets: VideoBatch["packets"]) => {
    await waitFor(() => expect(reads.has(id)).toBe(true));
    await act(async () => { const resolve = reads.get(id)!; reads.delete(id); resolve({ packets }); });
  };
  const output = (index: number) => {
    const close = vi.fn();
    act(() => decoders[index].init.output({ displayWidth: 640, displayHeight: 1280, close } as unknown as VideoFrame));
    expect(close).toHaveBeenCalledOnce();
  };
  return { ...view, invoke, decoders, drawImage, onCanvas, onFallback, send, output };
}

it("reopens a backlogged video lease with a fresh decoder and keyframe", async () => {
  const { invoke, decoders, drawImage, onCanvas, onFallback, send, output, unmount } = videoFixture();
  await send("lease-1", [config, key]);
  output(0);
  decoders[0].decodeQueueSize = 9;
  await send("lease-1", [{ ...key, kind: "delta" }, key]);
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === "stream-open")).toHaveLength(2));
  expect(invoke).toHaveBeenCalledWith("stream-close", { id: "lease-1" });
  expect(decoders[0].close).toHaveBeenCalledOnce();
  expect(decoders[0].decode).toHaveBeenCalledOnce();
  expect(onCanvas).toHaveBeenLastCalledWith(undefined);
  expect(onFallback).not.toHaveBeenCalled();
  drawImage.mockClear();
  output(0);
  act(() => decoders[0].init.error(new DOMException("Late decoder error")));
  expect(drawImage).not.toHaveBeenCalled();
  expect(onFallback).not.toHaveBeenCalled();
  await send("lease-2", [{ ...key, kind: "delta" }, config, { ...key, kind: "delta" }, key]);
  expect(decoders[1].configure).toHaveBeenCalledOnce();
  expect(decoders[1].decode).toHaveBeenCalledOnce();
  output(1);
  expect(drawImage).toHaveBeenCalledOnce();
  expect(onCanvas).toHaveBeenLastCalledWith(expect.any(HTMLCanvasElement));
  expect(onFallback).not.toHaveBeenCalled();
  unmount();
  expect(decoders[1].close).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("stream-close", { id: "lease-2" });
});

it("falls back to captures after exhausting two backlog reconnects even when frames were drawn", async () => {
  const { invoke, decoders, onFallback, send, output } = videoFixture();
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = `lease-${attempt + 1}`;
    await send(id, [config, key]);
    output(attempt);
    decoders[attempt].decodeQueueSize = 9;
    await send(id, [{ ...key, kind: "delta" }]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream-close", { id }));
    expect(decoders[attempt].close).toHaveBeenCalledOnce();
    if (attempt < 2) expect(onFallback).not.toHaveBeenCalled();
  }
  await waitFor(() => expect(onFallback).toHaveBeenCalledWith(expect.stringMatching(/fell behind.*Showing screen captures/u)));
  expect(onFallback).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.filter(([command]) => command === "stream-open")).toHaveLength(3);
});

it("waits for the old lease to close and cancels the reconnect when hidden", async () => {
  let finishClose!: () => void;
  const closing = new Promise<void>((resolve) => { finishClose = resolve; });
  const { invoke, decoders, onFallback, send } = videoFixture(() => closing);
  await send("lease-1", [config, key]);
  decoders[0].decodeQueueSize = 9;
  await send("lease-1", [key]);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("stream-close", { id: "lease-1" }));
  expect(invoke.mock.calls.filter(([command]) => command === "stream-open")).toHaveLength(1);
  expect(onFallback).not.toHaveBeenCalled();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => { finishClose(); });
  expect(decoders[0].close).toHaveBeenCalledOnce();
  expect(invoke.mock.calls.filter(([command]) => command === "stream-open")).toHaveLength(1);
  expect(onFallback).not.toHaveBeenCalled();
});
