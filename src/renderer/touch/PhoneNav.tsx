import { MessagesSquare, Settings } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import type { ExtensionRegistry } from "../extension-system";
import { getClientStorage } from "../../workbench/client-storage";
import { PanelIcon, type PanelIconComponent } from "../components/PanelIcon";
import { sameTab, type PhoneTab } from "../../workbench/phone-route";
import "./phone-nav.css";

/** Five destinations at most: home, three pages, Settings. */
const MAX_PAGES = 3;

/**
 * The pages this client last had, so the navigation shows them at once on
 * its next start, before their packages came over the network. An icon is
 * kept as its SVG's markup and drawn back as a CSS mask, where no script or
 * load of it can run.
 */
interface CachedPage { id: string; label: string; icon?: string }

const PAGE_CATALOG_KEY = "tau.page-catalog";

function readCatalog(): CachedPage[] {
  try {
    const pages: unknown = JSON.parse(getClientStorage()?.get(PAGE_CATALOG_KEY) ?? "[]");
    return Array.isArray(pages) ? pages : [];
  } catch {
    return [];
  }
}

function cachedIcon(icon: unknown): PanelIconComponent {
  const mask = `url("data:image/svg+xml,${encodeURIComponent(String(icon ?? ""))}")`;
  return ({ size = 15 }) => <span className="phone-nav-cached-icon" style={{ width: size, height: size, maskImage: mask }} />;
}

export interface PhoneNavItem {
  tab: PhoneTab;
  label: string;
  Icon?: PanelIconComponent | undefined;
  /** The page's count hook (`PageContribution.useBadge`). */
  useBadge?: (() => number | undefined) | undefined;
}

/**
 * Threads first, the app pages that claim a phone in their order, Settings
 * last. While the packages are still loading, the pages this client had last
 * time stand in for the ones not registered yet.
 */
export function phoneNavItems(registry: Pick<ExtensionRegistry, "getPages"> & Partial<Pick<ExtensionRegistry, "isLoadingExtensions">>): PhoneNavItem[] {
  const live = registry.getPages().map((page): PhoneNavItem => ({ tab: { kind: "page", page: page.id }, label: page.label, Icon: page.Icon, useBadge: page.useBadge }));
  const pages = registry.isLoadingExtensions?.()
    ? readCatalog().map((cached): PhoneNavItem => live.find((item) => item.tab.kind === "page" && item.tab.page === cached.id) ?? { tab: { kind: "page", page: cached.id }, label: cached.label, Icon: cachedIcon(cached.icon) })
    : live;
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
  useEffect(() => {
    if (loading) return;
    // Remembered once the packages are in, with the icons as drawn.
    const buttons = nav.current?.querySelectorAll(".phone-nav-icon") ?? [];
    const text = JSON.stringify(items.flatMap((item, index): CachedPage[] => item.tab.kind === "page"
      ? [{ id: item.tab.page, label: item.label, icon: buttons[index]?.querySelector("svg")?.outerHTML ?? "" }]
      : []));
    const storage = getClientStorage();
    if (storage?.get(PAGE_CATALOG_KEY) !== text) storage?.set(PAGE_CATALOG_KEY, text);
  });
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
