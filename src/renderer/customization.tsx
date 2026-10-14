import type { ComponentType, ReactNode } from "react";
import type { RegionPlacement, SlotPlacement } from "./extension-system";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "tau-part": { "data-tau-part": string; children?: import("react").ReactNode };
    }
  }
}

/** The contributions a user may hide, order, move or replace by name (ADR 0042). */
export type PartKind = "region" | "status" | "panel" | "page" | "sidebar" | "composer-control";

/** Components a contribution carries besides its body, each a part of its own. */
export const PART_FIELDS: Readonly<Record<PartKind, readonly string[]>> = {
  region: [],
  status: [],
  panel: [],
  page: ["Summary", "Sidebar"],
  sidebar: [],
  "composer-control": [],
};

/** `region:usage.juicebars`, `page:usage/Summary`. */
export function partName(kind: PartKind, id: string, field?: string): string {
  return field ? `${kind}:${id}/${field}` : `${kind}:${id}`;
}

/** The user's changes to other contributions, keyed by part name (API 1.62.0). */
export interface Customizations {
  /** Parts left out. A hidden page is gone with its entries; a hidden field leaves the rest of the page. */
  hidden?: readonly string[];
  /** A new `order` for a part, within its placement. */
  order?: Readonly<Record<string, number>>;
  /** A region moved to another placement. */
  placement?: Readonly<Record<string, RegionPlacement | SlotPlacement>>;
  /** A part drawn by another component, which gets the original's props plus `Original`. */
  replaced?: Readonly<Record<string, ComponentType<any>>>;
}

/** What `registerCustomizations` takes: one snapshot and a way to hear it change. */
export interface CustomizationLayer {
  getSnapshot(): Customizations;
  subscribe(listener: () => void): () => void;
  /** Layers apply from low to high; 0 by default. Customize Kit, the user's own, uses 100. */
  order?: number;
}

/** Layers in the order they apply: hidden parts add up, a later order, move or replacement wins. */
export function mergeCustomizations(layers: readonly Customizations[]): Customizations {
  if (layers.length === 0) return EMPTY;
  if (layers.length === 1) return layers[0]!;
  return {
    hidden: [...new Set(layers.flatMap((layer) => layer.hidden ?? []))],
    order: Object.assign({}, ...layers.map((layer) => layer.order ?? {})) as Record<string, number>,
    placement: Object.assign({}, ...layers.map((layer) => layer.placement ?? {})) as Record<string, RegionPlacement | SlotPlacement>,
    replaced: Object.assign({}, ...layers.map((layer) => layer.replaced ?? {})) as Record<string, ComponentType<any>>,
  };
}

export type ReplacementProps<P> = P & { Original: ComponentType<P> };

/** One part on offer here, drawn or customized away. */
export interface CustomizablePart {
  name: string;
  kind: PartKind;
  id: string;
  field?: string;
  label: string;
  extensionId: string;
  extensionName: string;
  hidden: boolean;
  replaced: boolean;
  /** A region's placement as the kit registered it. */
  placement?: RegionPlacement | SlotPlacement;
  /** Drawn on other kinds of device only (a phone's top bar): customizable from here, not shown here. */
  elsewhere?: boolean;
}

/** The part kind of a contribution kind as `ProfiledContribution` names it (`thread-list-title region`). */
export function partKindOf(kind: string): { kind: PartKind; placement?: string } | undefined {
  if (kind.endsWith(" region")) return { kind: "region", placement: kind.slice(0, -" region".length) };
  const named: Record<string, PartKind> = { panel: "panel", page: "page", "status item": "status", sidebar: "sidebar", "composer control": "composer-control" };
  return named[kind] ? { kind: named[kind] } : undefined;
}

const EMPTY: Customizations = {};

interface Applicable {
  id: string;
  order?: number;
  placement?: unknown;
  Component?: ComponentType<any>;
}

// One wrapper per replacement and original, so a part keeps its identity, and its state, across snapshots.
const wrappers = new WeakMap<ComponentType<any>, WeakMap<ComponentType<any>, ComponentType<any>>>();

function replacement(Replacement: ComponentType<any>, Original: ComponentType<any>, name: string): ComponentType<any> {
  const byOriginal = wrappers.get(Replacement) ?? new WeakMap<ComponentType<any>, ComponentType<any>>();
  wrappers.set(Replacement, byOriginal);
  const known = byOriginal.get(Original);
  if (known) return known;
  const Wrapped = (props: Record<string, unknown>): ReactNode => <Replacement {...props} Original={Original} />;
  Wrapped.displayName = `Customized(${name})`;
  byOriginal.set(Original, Wrapped);
  return Wrapped;
}

/** The registry's view of the one layer that applies; empty without one. */
export class CustomizationState {
  private snapshot: Customizations = EMPTY;
  private hidden = new Set<string>();

  set(snapshot: Customizations | undefined): void {
    this.snapshot = snapshot ?? EMPTY;
    this.hidden = new Set(this.snapshot.hidden ?? []);
  }

  isEmpty(): boolean {
    const { hidden, order, placement, replaced } = this.snapshot;
    return !hidden?.length && !hasKeys(order) && !hasKeys(placement) && !hasKeys(replaced);
  }

  isHidden(name: string): boolean {
    return this.hidden.has(name);
  }

  isReplaced(name: string): boolean {
    return Boolean(this.snapshot.replaced?.[name]);
  }

  /** The list as customized: hidden parts left out, the rest with their order, placement and components. */
  apply<T extends Applicable>(kind: PartKind, items: readonly T[]): T[] {
    if (this.isEmpty()) return [...items];
    const out: T[] = [];
    for (const item of items) {
      const customized = this.applyOne(kind, item);
      if (customized) out.push(customized);
    }
    return out;
  }

  applyOne<T extends Applicable>(kind: PartKind, item: T): T | undefined {
    if (this.isEmpty()) return item;
    const name = partName(kind, item.id);
    if (this.hidden.has(name)) return undefined;
    const { order, placement, replaced } = this.snapshot;
    let next: T | undefined;
    const change = (patch: Partial<T>) => { next = { ...(next ?? item), ...patch }; };
    if (order && typeof order[name] === "number") change({ order: order[name] } as Partial<T>);
    if (kind === "region" && placement?.[name]) change({ placement: placement[name] } as Partial<T>);
    const Replacement = replaced?.[name];
    if (Replacement && item.Component) change({ Component: replacement(Replacement, item.Component, name) } as Partial<T>);
    for (const field of PART_FIELDS[kind]) {
      const fieldName = partName(kind, item.id, field);
      const original = (item as unknown as Record<string, unknown>)[field] as ComponentType<any> | undefined;
      if (this.hidden.has(fieldName)) {
        // Without its own drawing the foot falls back to the page's figure or icon.
        change({ [field]: undefined } as Partial<T>);
        continue;
      }
      const FieldReplacement = replaced?.[fieldName];
      if (FieldReplacement) change({ [field]: replacement(FieldReplacement, original ?? Nothing, fieldName) } as Partial<T>);
    }
    return next ?? item;
  }
}

function Nothing(): null {
  return null;
}

function hasKeys(value: object | undefined): boolean {
  if (!value) return false;
  for (const _ in value) return true;
  return false;
}

/**
 * Names the part it wraps in the document, for user styles and the picker. It
 * draws no box (`display: contents`), so style the part's own element as
 * `[data-tau-part="…"] > *`.
 */
export function Part({ name, children }: { name: string; children?: ReactNode }) {
  return <tau-part data-tau-part={name}>{children}</tau-part>;
}
