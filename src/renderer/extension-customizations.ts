import { CustomizationState, mergeCustomizations, partKindOf, partName, PART_FIELDS, type CustomizablePart, type CustomizationLayer, type PartKind } from "./customization";
import type { ContributionOwner, RegionPlacement, SlotPlacement } from "./extension-system";
import type { ProfiledContribution } from "../workbench/client-profile";

interface PartContribution extends ContributionOwner {
  id: string;
  label?: string;
  placement?: unknown;
}
interface PartContributions { kind: PartKind; items: Iterable<PartContribution> }

/** Owns layer precedence, subscriptions and the customized part catalog. */
export class ExtensionCustomizations {
  private readonly state = new CustomizationState();
  private layers: Array<{ layer: CustomizationLayer }> = [];

  constructor(private readonly changed: () => void) {}

  register(layer: CustomizationLayer): () => void {
    const entry = { layer };
    this.layers.push(entry);
    const unsubscribe = layer.subscribe(() => this.update());
    this.update();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      unsubscribe();
      this.layers = this.layers.filter((held) => held !== entry);
      this.update();
    };
  }

  apply<T extends { id: string; order?: number }>(kind: PartKind, items: readonly T[]): T[] {
    return this.state.apply(kind, items).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  private update(): void {
    // By `order`, then as they came: a later layer's order, move or replacement wins, and hidden parts add up.
    const layers = this.layers.map((entry, index) => ({ entry, index }))
      .sort((a, b) => (a.entry.layer.order ?? 0) - (b.entry.layer.order ?? 0) || a.index - b.index);
    this.state.set(mergeCustomizations(layers.map(({ entry }) => entry.layer.getSnapshot())));
    this.changed();
  }

  /** Every part on offer on this client, with what the layer does to it. */
  parts(groups: readonly PartContributions[], elsewhere: readonly ProfiledContribution[]): CustomizablePart[] {
    const parts: CustomizablePart[] = [];
    const add = (kind: PartKind, items: Iterable<PartContribution>) => {
      for (const item of items) {
        const label = item.label ?? item.id;
        const part = (name: string, field?: string): CustomizablePart => ({
          name,
          kind,
          id: item.id,
          ...(field ? { field } : {}),
          label: field ? `${label} · ${field}` : label,
          extensionId: item.extensionId,
          extensionName: item.extensionName,
          hidden: this.state.isHidden(name),
          replaced: this.state.isReplaced(name),
          ...(kind === "region" && typeof item.placement === "string" ? { placement: item.placement as RegionPlacement | SlotPlacement } : {}),
        });
        parts.push(part(partName(kind, item.id)));
        for (const field of PART_FIELDS[kind]) {
          if ((item as unknown as Record<string, unknown>)[field]) parts.push(part(partName(kind, item.id, field), field));
        }
      }
    };
    for (const { kind, items } of groups) add(kind, items);
    // What another kind of device draws can be changed from here too; its fields are only known where it is drawn.
    const listed = new Set(parts.map((part) => part.name));
    for (const entry of elsewhere) {
      const mapped = partKindOf(entry.kind);
      if (!mapped) continue;
      const name = partName(mapped.kind, entry.id);
      if (listed.has(name)) continue;
      listed.add(name);
      parts.push({
        name, kind: mapped.kind, id: entry.id, label: entry.label ?? entry.id,
        extensionId: entry.extensionId, extensionName: entry.extensionName,
        hidden: this.state.isHidden(name), replaced: this.state.isReplaced(name),
        ...(mapped.placement ? { placement: mapped.placement as RegionPlacement | SlotPlacement } : {}),
        elsewhere: true,
      });
    }
    return parts;
  }

}
