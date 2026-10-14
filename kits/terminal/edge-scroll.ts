import type { Terminal } from "@xterm/xterm";

/** Pixels at the window edge that count as "pushing against it". */
const BAND = 8;
/** How close a screen edge must be to the window edge to count as flush. */
const SLACK = 2;
/** The farthest overshoot handed to xterm, in pixels (it scrolls at full speed from 50). */
const MAX_OVERSHOOT = 25;

const overshoot = (depth: number) => Math.max(1, Math.round(Math.min(depth / BAND, 1) * MAX_OVERSHOOT));

/**
 * xterm scrolls a selection drag only while the pointer is outside its screen,
 * which a terminal flush with the window edge never allows. Returns the
 * `clientY` to show xterm instead: just outside the screen, farther the
 * deeper the pointer is in the band. `undefined` leaves the pointer as it is.
 */
export function dragEdgeY(screen: { top: number; bottom: number }, viewportHeight: number, clientY: number): number | undefined {
  if (clientY >= screen.top && clientY <= screen.bottom) {
    if (screen.bottom >= viewportHeight - SLACK && clientY > viewportHeight - BAND) return screen.bottom + overshoot(clientY - (viewportHeight - BAND));
    if (screen.top <= SLACK && clientY < BAND) return screen.top - overshoot(BAND - clientY);
  }
  return undefined;
}

/**
 * Lets a selection drag held at the window edge scroll the terminal. xterm
 * reads the pointer from the event, so the position it sees is replaced in the
 * capture phase, before its own listener; its drag timer then scrolls and
 * extends the selection until the pointer leaves the band.
 */
export function scrollDragAtWindowEdge(terminal: Terminal, host: HTMLElement): () => void {
  const doc = host.ownerDocument;
  let dragging = false;
  const down = (event: MouseEvent) => { dragging = event.button === 0 && terminal.modes.mouseTrackingMode === "none"; };
  const up = () => { dragging = false; };
  const move = (event: MouseEvent) => {
    if (event.buttons === 0) dragging = false;
    const screen = dragging ? host.querySelector(".xterm-screen") : null;
    if (!screen || !doc.defaultView) return;
    const y = dragEdgeY(screen.getBoundingClientRect(), doc.defaultView.innerHeight, event.clientY);
    if (y !== undefined) Object.defineProperty(event, "clientY", { value: y });
  };
  host.addEventListener("mousedown", down, true);
  doc.addEventListener("mouseup", up, true);
  doc.addEventListener("mousemove", move, true);
  return () => {
    host.removeEventListener("mousedown", down, true);
    doc.removeEventListener("mouseup", up, true);
    doc.removeEventListener("mousemove", move, true);
  };
}
