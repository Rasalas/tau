/**
 * jsdom has no `PointerEvent`, so `fireEvent.pointerDown(el, { pointerType })`
 * would lose the pointer's kind. A MouseEvent that keeps it is enough for
 * code that reads `pointerType`, `pointerId` and the coordinates.
 */
export function installPointerEvents(): void {
  if (typeof window.PointerEvent === "function") return;
  class TestPointerEvent extends MouseEvent {
    readonly pointerType: string;
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.defineProperty(window, "PointerEvent", { value: TestPointerEvent, configurable: true, writable: true });
}
