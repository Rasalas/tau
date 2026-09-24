/**
 * Whether the primary pointer is a finger: no hover, and a keyboard that
 * slides in over the page. A laptop with a touch screen still answers false.
 */
export function primaryPointerIsTouch(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}
