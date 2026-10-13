import type { ThreadBackgroundCapability } from "../runtime-types.js";
import { ThreadBackgroundWork } from "../thread-background-work.js";

/** Routes a kit's test operations through the same combined capability its Stop buttons use. */
export function combinedBackgroundWork(capability: ThreadBackgroundCapability): ThreadBackgroundCapability {
  const work = new ThreadBackgroundWork(() => capability, () => undefined);
  return work.forThread("test-thread")!;
}
