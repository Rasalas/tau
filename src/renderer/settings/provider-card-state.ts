import { createContext, useContext, useEffect } from "react";

/**
 * The state words in a Providers card's head. The card's own rows name them
 * (the program's row, the account's row) through this context, which
 * `ProvidersPage` provides around each card; elsewhere it is absent and a
 * row says nothing upwards.
 */
export type ProviderCardBadgeTone = "neutral" | "success" | "warn" | "danger";

export interface ProviderCardBadge {
  label: string;
  tone: ProviderCardBadgeTone;
}

/** Which part of the card a badge speaks for; the head shows them in this order. */
export type ProviderCardBadgeSource = "program" | "account";

export type ProviderCardBadgeSlot = (source: ProviderCardBadgeSource, badge: ProviderCardBadge | undefined) => void;

export const ProviderCardContext = createContext<ProviderCardBadgeSlot | undefined>(undefined);

/** Puts `badge` into the head of the card this is drawn in, for as long as it is drawn. */
export function useProviderCardBadge(source: ProviderCardBadgeSource, badge: ProviderCardBadge | undefined): void {
  const slot = useContext(ProviderCardContext);
  const label = badge?.label;
  const tone = badge?.tone;
  useEffect(() => {
    if (!slot) return undefined;
    slot(source, label && tone ? { label, tone } : undefined);
    return () => slot(source, undefined);
  }, [slot, source, label, tone]);
}

/** The same as `useProviderCardBadge`, for a kit that reaches it through a chunk: draws nothing. */
export function ProviderCardBadgeReport({ source, badge }: { source: ProviderCardBadgeSource; badge: ProviderCardBadge | undefined }): null {
  useProviderCardBadge(source, badge);
  return null;
}
