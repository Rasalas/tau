import { useLayoutEffect, useRef, useState } from "react";

interface Layer {
  /** When it opened; a parent renders before its child, so the child is higher. */
  order: number;
  close(): void;
}

/**
 * The open overlays that close on Escape. One window listener in the capture
 * phase closes only the newest and consumes the key, so a menu over a dialog
 * closes alone and nothing under either (an abort, a panel) hears it.
 */
const layers: Layer[] = [];
let opened = 0;

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const top = layers.reduce<Layer | undefined>((best, layer) => !best || layer.order > best.order ? layer : best, undefined);
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.close();
}

/** Closes this overlay on Escape while it is the topmost one. */
export function useEscapeLayer(onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  const [order] = useState(() => ++opened);
  useLayoutEffect(() => {
    const layer = { order, close: () => close.current() };
    if (layers.length === 0) window.addEventListener("keydown", onKeyDown, true);
    layers.push(layer);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (layers.length === 0) window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [order]);
}
