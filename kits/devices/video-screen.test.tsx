// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
  const invoke = vi.fn(async <T,>(command: string): Promise<T> => {
    if (command === "stream-open") return { id: "lease" } as T;
    if (command === "stream-read") {
      if (!sent) { sent = true; return batch as T; }
      return new Promise<T>(() => undefined);
    }
    return undefined as T;
  });
  const dimensions: number[][] = [];
  const onCanvas = vi.fn((canvas: HTMLCanvasElement | undefined) => { if (canvas) dimensions.push([canvas.width, canvas.height]); }), onFallback = vi.fn();
  render(<VideoDeviceScreen target={target} invoke={invoke} name="Phone" onCanvas={onCanvas} onFallback={onFallback} />);
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
