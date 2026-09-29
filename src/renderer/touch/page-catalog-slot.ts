import type { PhoneNavItem } from "./PhoneNav";

/**
 * Remembers a client's pages across starts, so the navigation has them before
 * the packages that register them came over the network. The web client sets
 * one (`src/web/page-catalog.tsx`); a window loads its packages from disk.
 */
export interface PageCatalog {
  /** The pages of the last start, the ones registered since in their place. */
  read(live: PhoneNavItem[]): PhoneNavItem[];
  /** The pages as drawn in `nav`, once the packages are in. */
  write(nav: HTMLElement | null, items: readonly PhoneNavItem[]): void;
}

let catalog: PageCatalog | undefined;
export function setPageCatalog(next: PageCatalog | undefined): void {
  catalog = next;
}

export function pageCatalog(): PageCatalog | undefined {
  return catalog;
}
