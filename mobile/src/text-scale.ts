import type { SystemTextScale } from "../../src/renderer/type-scale";

/** The plugin's side of Android's font scale (`TauNativePlugin.textScale` and its `textScale` event). */
export interface TextScalePort {
  read(): Promise<number>;
  listen(listener: (scale: number) => void): Promise<() => void>;
}

/**
 * Android's font scale for the page. The plugin turns the web view's own text
 * zoom off, which scales text but not the rows around it, so this is the only
 * scaling there is.
 */
export async function androidFontScale(port: TextScalePort): Promise<SystemTextScale> {
  let scale = await port.read();
  const listeners = new Set<() => void>();
  await port.listen((next) => {
    scale = next;
    for (const listener of [...listeners]) listener();
  });
  return {
    read: () => scale,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
