/**
 * Where a phone is: the thread list is home; a chat, a sub-view of a page and
 * a Settings section are sub-pages one level down; an app page and Settings
 * are main pages beside home, reached from the bottom navigation. The
 * browser's history mirrors the path from home, so the system's back (Android
 * back, an iOS swipe) steps out one level and stops at the list.
 */
export type PhoneRoute =
  | { kind: "threads" }
  /** Without `thread`, a new thread's draft. */
  | { kind: "chat"; thread?: string }
  /** `depth` counts the views the page stepped into. */
  | { kind: "page"; page: string; depth: number }
  /** With `section`, one of Settings' pages; without, the list of sections. */
  | { kind: "settings"; section?: string };

export const PHONE_HOME: PhoneRoute = { kind: "threads" };

/** The bottom navigation's destinations: home, the app pages, Settings. */
export type PhoneTab = { kind: "threads" } | { kind: "page"; page: string } | { kind: "settings" };

/** A main page shows the bottom navigation; a sub-page does not. */
export function showsPhoneNav(route: PhoneRoute): boolean {
  switch (route.kind) {
    case "threads": return true;
    case "chat": return false;
    case "page": return route.depth === 0;
    case "settings": return route.section === undefined;
  }
}

/** Which destination of the bottom navigation the route belongs to. */
export function phoneTab(route: PhoneRoute): PhoneTab {
  switch (route.kind) {
    case "threads":
    case "chat": return { kind: "threads" };
    case "page": return { kind: "page", page: route.page };
    case "settings": return { kind: "settings" };
  }
}

export function sameTab(a: PhoneTab, b: PhoneTab): boolean {
  return a.kind === b.kind && (a.kind !== "page" || a.page === (b as { page: string }).page);
}
