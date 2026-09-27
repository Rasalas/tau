/**
 * Whether the primary pointer is a finger: no hover, and a keyboard that
 * slides in over the page. A laptop with a touch screen still answers false.
 */
export function primaryPointerIsTouch(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

/** Whether an on-screen keyboard covers the page now, as the compact layout marks it on `<body>` (touch/TouchLayer.tsx). */
export function onScreenKeyboardShown(): boolean {
  return typeof document !== "undefined" && document.body.hasAttribute("data-keyboard");
}
