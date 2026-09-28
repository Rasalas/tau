import { MessagesSquare, Settings } from "lucide-react";
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

/** Threads first, the app pages that claim a phone in their order, Settings last. */
export function phoneNavItems(registry: Pick<ExtensionRegistry, "getPages">): PhoneNavItem[] {
  return [
    { tab: { kind: "threads" }, label: "Threads", Icon: MessagesSquare },
    ...registry.getPages().slice(0, MAX_PAGES).map((page): PhoneNavItem => ({ tab: { kind: "page", page: page.id }, label: page.label, Icon: page.Icon, useBadge: page.useBadge })),
    { tab: { kind: "settings" }, label: "Settings", Icon: Settings },
  ];
}

/**
 * A phone's bottom navigation, on its main pages only: an icon over a short
 * label per destination, each the full height of the bar to tap.
 */
export function PhoneNav({ items, current, onSelect }: {
  items: readonly PhoneNavItem[];
  current: PhoneTab;
  onSelect(tab: PhoneTab): void;
}) {
  return <nav className="phone-nav" aria-label="Main">
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
