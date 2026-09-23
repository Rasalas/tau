import { useCallback, useSyncExternalStore } from "react";
import type { MenuPoint, NativeMenuEntry } from "../../../shared/context-menu";
import type { Platform } from "../../../workbench/platform";
import { usePlatform } from "../../platform-context";
import type { MenuSection } from "../Menu";
import { Menu } from "../../deferred-surfaces";

/** The sections a `Menu` draws, as the entries an OS menu takes. */
export function nativeMenuEntries(sections: readonly MenuSection[]): NativeMenuEntry[] {
  const out: NativeMenuEntry[] = [];
  sections.forEach((section, index) => {
    if (section.items.length === 0 && !section.heading) return;
    if (index > 0 && out.length > 0) out.push({ type: "separator" });
    if (section.heading) out.push({ type: "heading", label: section.heading });
    for (const item of section.items) {
      out.push({
        type: "item",
        id: item.id,
        label: item.badge ? `${item.label} (${item.badge})` : item.label,
        ...(item.disabled ? { enabled: false } : {}),
        ...(item.selected ? { checked: true } : {}),
        ...(item.submenu ? { submenu: nativeMenuEntries(item.submenu) } : {}),
      });
    }
  });
  return out;
}

interface Pending {
  point: MenuPoint;
  sections: MenuSection[];
  resolve(id: string | undefined): void;
}

let pending: Pending | undefined;
const listeners = new Set<() => void>();
const publish = (next: Pending | undefined) => {
  pending?.resolve(undefined);
  pending = next;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** The page's own right-click menu, for a client whose OS draws none; core mounts it once. */
export function ContextMenuLayer() {
  const current = useSyncExternalStore(subscribe, () => pending);
  if (!current) return null;
  const settle = (id: string | undefined) => {
    if (pending !== current) return;
    pending = undefined;
    current.resolve(id);
    listeners.forEach((listener) => listener());
  };
  return <Menu
    key={`${current.point.x}:${current.point.y}`}
    at={current.point}
    sections={current.sections}
    onSelect={(id) => settle(id)}
    onClose={() => settle(undefined)}
  />;
}

interface ContextMenuEvent {
  clientX: number;
  clientY: number;
  currentTarget?: EventTarget | null;
  preventDefault?(): void;
}

/** Where a menu opened from the keyboard (Shift-F10, the menu key) goes: under the element, not at 0,0. */
function pointOf(event: ContextMenuEvent): MenuPoint {
  if ((event.clientX !== 0 || event.clientY !== 0) || !(event.currentTarget instanceof Element)) return { x: event.clientX, y: event.clientY };
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left + 8, y: rect.bottom };
}

/** Opens `sections` at the event's point: the OS's menu where the platform has one, the page's otherwise. */
export async function openContextMenu(platform: Platform, event: ContextMenuEvent, sections: MenuSection[]): Promise<string | undefined> {
  event.preventDefault?.();
  const point = pointOf(event);
  if (platform.contextMenu) {
    try {
      return await platform.contextMenu.show(nativeMenuEntries(sections), point);
    } catch {
      // Refused (a window without menus, a host that answers for none): the page draws it.
    }
  }
  return new Promise((resolve) => publish({ point, sections, resolve }));
}

/** `openContextMenu` bound to this client's platform. */
export function useContextMenu(): (event: ContextMenuEvent, sections: MenuSection[]) => Promise<string | undefined> {
  const platform = usePlatform();
  return useCallback((event, sections) => openContextMenu(platform, event, sections), [platform]);
}
