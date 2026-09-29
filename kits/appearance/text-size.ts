import { getClientStorage } from "tau";

export const TEXT_SIZES = ["small", "default", "large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const TEXT_SIZE_LABELS: Record<TextSize, string> = { small: "Small", default: "Default", large: "Large" };
/** Client storage: each device keeps its own, a phone its larger text and a desktop its smaller. */
export const TEXT_SIZE_KEY = "tau.appearance.text-size";

export function readTextSize(raw: unknown): TextSize {
  return TEXT_SIZES.includes(raw as TextSize) ? raw as TextSize : "default";
}

/**
 * This device's text size: `data-text-size` on <html>, which the kit's
 * stylesheet turns into core's type scale a step down or up.
 */
export class TextSizeStore {
  private value: TextSize;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly doc: Document = document) {
    this.value = readTextSize(getClientStorage()?.get(TEXT_SIZE_KEY));
    this.apply();
  }

  getSnapshot = (): TextSize => this.value;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  set = (next: TextSize): void => {
    if (next === this.value) return;
    this.value = next;
    const storage = getClientStorage();
    if (next === "default") storage?.remove(TEXT_SIZE_KEY);
    else storage?.set(TEXT_SIZE_KEY, next);
    this.apply();
    for (const listener of [...this.listeners]) listener();
  };

  dispose(): void {
    delete this.doc.documentElement.dataset.textSize;
  }

  private apply(): void {
    const root = this.doc.documentElement;
    if (this.value === "default") delete root.dataset.textSize;
    else root.dataset.textSize = this.value;
  }
}
