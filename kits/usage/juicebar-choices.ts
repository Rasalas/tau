import { getClientStorage } from "tau";

/** The device's own, whatever host it shows (`device:`): a phone keeps one choice for all its hosts. */
const CHOICES_KEY = "device:tau.usage.sidebar-windows";
const EARLIER_KEY = "tau.usage.sidebar-windows";

/** Which windows the foot shows, chosen per device; unchosen ones follow `shownByDefault`. */
export function createJuicebarChoices() {
  let choices: Record<string, boolean> | undefined;
  const listeners = new Set<() => void>();
  const read = (): Record<string, boolean> => {
    if (choices) return choices;
    try {
      const storage = getClientStorage();
      const stored = JSON.parse(storage?.get(CHOICES_KEY) ?? storage?.get(EARLIER_KEY) ?? "null") as unknown;
      choices = stored && typeof stored === "object" ? stored as Record<string, boolean> : {};
    } catch {
      choices = {};
    }
    return choices;
  };
  return {
    getSnapshot: read,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(key: string, shown: boolean): void {
      choices = { ...read(), [key]: shown };
      try { getClientStorage()?.set(CHOICES_KEY, JSON.stringify(choices)); } catch { /* kept for this run */ }
      for (const listener of [...listeners]) listener();
    },
  };
}

export type JuicebarChoices = ReturnType<typeof createJuicebarChoices>;
