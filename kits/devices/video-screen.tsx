import { useEffect, useRef, useState } from "react";
import type { Target } from "./protocol.js";
import type { VideoBatch } from "./stream-protocol.js";

type Invoke = <T>(command: string, input?: unknown) => Promise<T>;
interface Props {
  target: Target; invoke: Invoke; name: string;
  onCanvas: (canvas: HTMLCanvasElement | undefined) => void;
  onFallback: (reason: string) => void;
  onPointerDown?: React.PointerEventHandler<HTMLCanvasElement>;
  onPointerUp?: React.PointerEventHandler<HTMLCanvasElement>;
  onPointerCancel?: React.PointerEventHandler<HTMLCanvasElement>;
}

/** WebCodecs receives real AVCC/Annex-B packets through Tau's authenticated host protocol. */
export default function VideoDeviceScreen({ target, invoke, name, onCanvas, onFallback, ...pointer }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (!visible) return;
    let stopped = false, id: string | undefined, decoder: VideoDecoder | undefined;
    let configured = false, awaitingKey = true, frameSeen = false;
    let reconnects = 0;
    let firstFrame: ReturnType<typeof setTimeout> | undefined;
    const closeVideo = async () => {
      clearTimeout(firstFrame);
      const previous = decoder; decoder = undefined;
      if (previous?.state !== "closed") previous?.close();
      onCanvas(undefined);
      const leaseId = id; id = undefined;
      if (leaseId) await invoke("stream-close", { id: leaseId }).catch(() => undefined);
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      void closeVideo();
    };
    const fail = (reason: string) => { if (!stopped) { stop(); onFallback(reason); } };
    const video = async () => {
      if (typeof VideoDecoder === "undefined" || typeof EncodedVideoChunk === "undefined") { fail("Video decoding is unavailable. Showing screen captures."); return; }
      let backlogged = false;
      try {
        const currentDecoder = new VideoDecoder({
          output(frame) {
            try {
              const surface = canvas.current;
              if (stopped || decoder !== currentDecoder || !surface) return;
              const paint = surface.getContext("2d");
              if (!paint) { fail("Device video cannot draw its screen."); return; }
              const resized = surface.width !== frame.displayWidth || surface.height !== frame.displayHeight;
              if (surface.width !== frame.displayWidth) surface.width = frame.displayWidth;
              if (surface.height !== frame.displayHeight) surface.height = frame.displayHeight;
              paint.drawImage(frame, 0, 0, surface.width, surface.height);
              if (!frameSeen || resized) { frameSeen = true; clearTimeout(firstFrame); onCanvas(surface); }
            } finally { frame.close(); }
          },
          error: () => { if (decoder === currentDecoder) fail("Device video could not be decoded. Showing screen captures."); },
        });
        decoder = currentDecoder;
        const lease = await invoke<{ id: string }>("stream-open", target);
        id = lease.id;
        if (stopped) { void invoke("stream-close", { id }).catch(() => undefined); return; }
        firstFrame = setTimeout(() => fail("Device video received no frames. Showing screen captures."), 15_000);
        for (;;) {
          if (stopped) return;
          const batch = await invoke<VideoBatch>("stream-read", { id });
          if (stopped) return;
          if (batch.error) throw new Error(batch.error);
          for (const packet of batch.packets) {
            const bytes = Uint8Array.from(atob(packet.data), (character) => character.charCodeAt(0));
            if (packet.kind === "config") {
              if (!packet.codec) throw new Error("Device video supplied no codec.");
              const config: VideoDecoderConfig = { codec: packet.codec, optimizeForLatency: true, ...(bytes.length ? { description: bytes } : {}) };
              const supported = await VideoDecoder.isConfigSupported(config);
              if (stopped) return;
              if (!supported.supported) throw new Error("This device cannot decode the simulator's H.264 profile.");
              decoder.configure(config); configured = true; awaitingKey = true;
              continue;
            }
            if (!configured || (awaitingKey && packet.kind !== "key")) continue;
            if (decoder.decodeQueueSize > 8) { backlogged = true; throw new Error("Device video decoding fell behind."); }
            awaitingKey = false;
            decoder.decode(new EncodedVideoChunk({ type: packet.kind === "key" ? "key" : "delta", data: bytes, timestamp: packet.timestamp }));
          }
        }
      } catch (error) {
        if (stopped) return;
        if (backlogged && reconnects < 2) {
          reconnects++;
          // A new subscription supplies an immediate keyframe, even for an idle simulator.
          await closeVideo();
          if (stopped) return;
          configured = false; awaitingKey = true; frameSeen = false;
          return video();
        }
        fail(`${error instanceof Error ? error.message : "Device video stopped."} Showing screen captures.`);
      }
    };
    void video();
    return stop;
  }, [target.hostId, target.deviceId, invoke, onCanvas, onFallback, visible]);
  return <canvas ref={canvas} role="img" aria-label={`${name} live screen`} {...pointer} />;
}
