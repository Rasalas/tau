import type { ComponentType, ReactNode } from "react";
import type { SettingsCardId, SettingsSectionProps } from "../extension-system";
import { SettingsCard } from "./settings-layout";

/** A row in its card, among the rows kits add there: lower `order` first. */
export type PlacedRow = { order: number; node: ReactNode };

/** A section a package added to one of core's pages, as the page receives it. */
export type CardSection = { id: string; card?: SettingsCardId | undefined; order?: number | undefined; Component: ComponentType<SettingsSectionProps> };

/**
 * A card of core's own rows and the rows kits add with
 * `registerSettingsSection({ card })`, in `order`; none when it holds no row.
 */
export function SectionCard({ title, card, own = [], sections, onNotify }: {
  title: string;
  card: SettingsCardId;
  own?: readonly PlacedRow[];
  sections: readonly CardSection[];
  onNotify(message: string, level?: "info" | "warning" | "error"): void;
}) {
  const rows = [
    ...own,
    ...sections.filter((section) => section.card === card).map(({ id, order = 100, Component }) => ({ order, node: <Component key={id} onNotify={onNotify} onChanged={() => undefined} /> })),
  ].sort((left, right) => left.order - right.order);
  return rows.length ? <SettingsCard title={title}>{rows.map((row) => row.node)}</SettingsCard> : null;
}
