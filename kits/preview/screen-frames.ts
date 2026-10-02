import type { ComputerUseScreenService } from "./screen-protocol.js";
import type { LiveFrameSource } from "./live-frames.js";

/** The host's live window capture, with driver screenshots on older hosts. */
export function screenFrameSource(service: ComputerUseScreenService, threadId: string): LiveFrameSource {
  if (service.viewFrame) return async (maxWidth, since) => await service.viewFrame!(threadId, maxWidth, since) ?? null;
  // A Computer Use kit from before API 1.13.0: the driver's full-size screenshot, as it is.
  return async (_maxWidth, since) => {
    const frame = await service.frame(threadId);
    if (!frame) return null;
    const id = `d${String(frame.seq)}`;
    return id === since ? { id, unchanged: true } : { id, data: frame.data, width: frame.width, height: frame.height, mimeType: frame.mimeType };
  };
}

