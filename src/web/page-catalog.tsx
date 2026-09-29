import type { PanelIconComponent } from "../renderer/components/PanelIcon";
import type { PhoneNavItem } from "../renderer/touch/PhoneNav";
import type { PageCatalog } from "../renderer/touch/page-catalog-slot";
import type { ClientStorage } from "../workbench/client-storage";

/** A page as the client remembers it; its icon is the SVG's markup, drawn back as a CSS mask, where none of it can run. */
interface CachedPage { id: string; label: string; icon?: string }

const KEY = "tau.page-catalog";

function cachedIcon(icon: unknown): PanelIconComponent {
  const mask = `url("data:image/svg+xml,${encodeURIComponent(String(icon ?? ""))}")`;
  return ({ size = 15 }) => <span className="phone-nav-cached-icon" style={{ width: size, height: size, maskImage: mask }} />;
}

/** The phone navigation's pages, kept in the client's storage. */
export function storedPageCatalog(storage: () => ClientStorage | undefined): PageCatalog {
  return {
    read: (live) => {
      let pages: CachedPage[] = [];
      try {
        const stored: unknown = JSON.parse(storage()?.get(KEY) ?? "[]");
        if (Array.isArray(stored)) pages = stored as CachedPage[];
      } catch {
        pages = [];
      }
      return pages.map((cached): PhoneNavItem => live.find((item) => item.tab.kind === "page" && item.tab.page === cached.id)
        ?? { tab: { kind: "page", page: cached.id }, label: String(cached.label), Icon: cachedIcon(cached.icon) });
    },
    write: (nav, items) => {
      const icons = nav?.querySelectorAll(".phone-nav-icon") ?? [];
      const text = JSON.stringify(items.flatMap((item, index): CachedPage[] => item.tab.kind === "page"
        ? [{ id: item.tab.page, label: item.label, icon: icons[index]?.querySelector("svg")?.outerHTML ?? "" }]
        : []));
      const store = storage();
      if (store && store.get(KEY) !== text) store.set(KEY, text);
    },
  };
}
