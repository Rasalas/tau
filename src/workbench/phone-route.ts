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

export function routeKey(route: PhoneRoute): string {
  switch (route.kind) {
    case "threads": return "threads";
    case "chat": return `chat:${route.thread ?? ""}`;
    case "page": return `page:${route.page}:${route.depth}`;
    case "settings": return route.section === undefined ? "settings" : `settings:${route.section}`;
  }
}

export function sameRoute(a: PhoneRoute, b: PhoneRoute): boolean {
  return routeKey(a) === routeKey(b);
}

/** The routes from home to this one, home first. */
export function routePath(route: PhoneRoute): PhoneRoute[] {
  switch (route.kind) {
    case "threads": return [PHONE_HOME];
    case "chat": return [PHONE_HOME, route];
    case "page": return [PHONE_HOME, ...Array.from({ length: route.depth + 1 }, (_, depth) => ({ kind: "page" as const, page: route.page, depth }))];
    case "settings": return route.section === undefined ? [PHONE_HOME, route] : [PHONE_HOME, { kind: "settings" }, route];
  }
}

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

/**
 * How the history moves from one route to the next, keeping it the path from
 * home: go back `back` entries, then replace the one it lands on, then push
 * the rest. Leaving a sub-page for its parent is a plain back.
 */
export interface HistorySteps {
  back: number;
  replace?: PhoneRoute;
  push: PhoneRoute[];
}

export function historySteps(from: PhoneRoute, to: PhoneRoute): HistorySteps {
  const before = routePath(from);
  const after = routePath(to);
  let shared = 0;
  while (shared < before.length && shared < after.length && sameRoute(before[shared]!, after[shared]!)) shared += 1;
  const pops = before.length - shared;
  const rest = after.slice(shared);
  if (pops === 0) return { back: 0, push: rest };
  if (rest.length === 0) return { back: pops, push: [] };
  return { back: pops - 1, replace: rest[0]!, push: rest.slice(1) };
}

// The address shows the route, so a reload, a link or a push lands there.
const THREAD = "thread";
const PAGE = "page";
const SETTINGS = "settings";

export function routeFromUrl(href: string): PhoneRoute {
  const params = new URL(href).searchParams;
  const thread = params.get(THREAD);
  if (thread) return { kind: "chat", thread };
  const page = params.get(PAGE);
  if (page) return { kind: "page", page, depth: 0 };
  if (params.has(SETTINGS)) {
    const section = params.get(SETTINGS);
    return section ? { kind: "settings", section } : { kind: "settings" };
  }
  return PHONE_HOME;
}

export function urlWithRoute(href: string, route: PhoneRoute): string {
  const url = new URL(href);
  for (const name of [THREAD, PAGE, SETTINGS]) url.searchParams.delete(name);
  if (route.kind === "chat" && route.thread) url.searchParams.set(THREAD, route.thread);
  if (route.kind === "page") url.searchParams.set(PAGE, route.page);
  if (route.kind === "settings") url.searchParams.set(SETTINGS, route.section ?? "");
  // `?settings=` reads better as `?settings`.
  const search = url.search.replace(/([?&]settings)=(?=&|$)/u, "$1");
  return `${url.pathname}${search}${url.hash}`;
}

/** The history entry's own record of its route; a sub-view's depth lives only here. */
const STATE_KEY = "tauPhoneRoute";

export function routeFromState(state: unknown): PhoneRoute | undefined {
  if (!state || typeof state !== "object") return undefined;
  const route = (state as Record<string, unknown>)[STATE_KEY];
  if (!route || typeof route !== "object") return undefined;
  const candidate = route as Partial<Record<string, unknown>>;
  switch (candidate.kind) {
    case "threads": return PHONE_HOME;
    case "chat": return typeof candidate.thread === "string" ? { kind: "chat", thread: candidate.thread } : { kind: "chat" };
    case "page": return typeof candidate.page === "string" && typeof candidate.depth === "number" ? { kind: "page", page: candidate.page, depth: candidate.depth } : undefined;
    case "settings": return typeof candidate.section === "string" ? { kind: "settings", section: candidate.section } : { kind: "settings" };
    default: return undefined;
  }
}

export function stateWithRoute(state: unknown, route: PhoneRoute): Record<string, unknown> {
  return { ...(state && typeof state === "object" ? state as Record<string, unknown> : {}), [STATE_KEY]: route };
}
