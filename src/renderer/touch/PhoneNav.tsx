import { MessagesSquare, Settings } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ExtensionRegistry } from "../extension-system";
import { PanelIcon, type PanelIconComponent } from "../components/PanelIcon";
import { sameTab, type PhoneTab } from "../../workbench/phone-route";
import "./phone-nav.css";

/** Five destinations at most: home, three pages, Settings. */
const MAX_PAGES = 3;

export interface PhoneNavItem {
  tab: PhoneTab;
  label: string;
  Icon?: PanelIconComponent | undefined;
  /** The page's count hook (`PageContribution.useBadge`). */
  useBadge?: (() => number | undefined) | undefined;
}

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

/**
 * Threads first, the app pages that claim a phone in their order, Settings
 * last. While the packages are still loading, the remembered pages stand in
 * for the ones not registered yet.
 */
export function phoneNavItems(registry: Pick<ExtensionRegistry, "getPages"> & Partial<Pick<ExtensionRegistry, "isLoadingExtensions">>): PhoneNavItem[] {
  const live = registry.getPages().map((page): PhoneNavItem => ({ tab: { kind: "page", page: page.id }, label: page.label, Icon: page.Icon, useBadge: page.useBadge }));
  const pages = catalog && registry.isLoadingExtensions?.() ? catalog.read(live) : live;
  return [
    { tab: { kind: "threads" }, label: "Threads", Icon: MessagesSquare },
    ...pages.slice(0, MAX_PAGES),
    { tab: { kind: "settings" }, label: "Settings", Icon: Settings },
  ];
}

/** The bottom navigation of a workbench, following its registry and remembering its pages. */
export function RegistryPhoneNav({ registry, current, onSelect }: { registry: ExtensionRegistry; current: PhoneTab; onSelect(tab: PhoneTab): void }) {
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const items = phoneNavItems(registry);
  const nav = useRef<HTMLElement>(null);
  const loading = registry.isLoadingExtensions();
  useEffect(() => { if (!loading) catalog?.write(nav.current, items); });
  return <PhoneNav ref={nav} items={items} current={current} onSelect={onSelect} />;
}

/**
 * A phone's bottom navigation, on its main pages only: an icon over a short
 * label per destination, each the full height of the bar to tap.
 */
export function PhoneNav({ items, current, onSelect, ref }: {
  items: readonly PhoneNavItem[];
  current: PhoneTab;
  onSelect(tab: PhoneTab): void;
  ref?: React.Ref<HTMLElement>;
}) {
  return <nav className="phone-nav" aria-label="Main" ref={ref}>
    {items.map((item) => {
      const active = sameTab(item.tab, current);
      return <PhoneNavButton
        key={item.tab.kind === "page" ? `page:${item.tab.page}` : item.tab.kind}
        item={item}
        active={active}
        onSelect={onSelect}
      />;
    })}
  </nav>;
}

const noBadge = () => undefined;

function PhoneNavButton({ item, active, onSelect }: { item: PhoneNavItem; active: boolean; onSelect(tab: PhoneTab): void }) {
  const count = (item.useBadge ?? noBadge)();
  return <button
    type="button"
    className="phone-nav-item"
    aria-current={active ? "page" : undefined}
    {...(count ? { "aria-label": `${item.label}, ${count}` } : {})}
    onClick={() => { if (!active) onSelect(item.tab); }}
  >
    <span className="phone-nav-icon" aria-hidden="true">
      <PanelIcon Icon={item.Icon} size={22} />
      {count ? <span className="page-badge">{count > 99 ? "99+" : count}</span> : null}
    </span>
    <span className="phone-nav-label">{item.label}</span>
  </button>;
}
