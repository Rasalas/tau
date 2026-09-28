import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The element at the right of the page head; `null` until it is drawn, `undefined` outside Settings. */
export const SettingsPageActionSlot = createContext<HTMLElement | null | undefined>(undefined);

/**
 * The page's own action, drawn at the right of its head in Settings while the
 * page keeps the state behind it (API 1.26.0). Outside a page head, in place.
 */
export function SettingsPageAction({ children }: { children: ReactNode }) {
  const slot = useContext(SettingsPageActionSlot);
  if (slot === undefined) return <>{children}</>;
  return slot ? createPortal(children, slot) : null;
}
