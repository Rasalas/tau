import { PHONE_HOME, type PhoneRoute } from "./phone-route";

/*
 * A phone's route in the browser's history and address; only the touch
 * layer's chunk needs it, so it stays out of the first paint.
 */

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
    case "settings": {
      if (route.section === undefined) return [PHONE_HOME, route];
      // `extensions/<id>` sits under `extensions`: back from an extension's page lands on the list.
      const slash = route.section.indexOf("/");
      const parent = slash > 0 ? [{ kind: "settings" as const, section: route.section.slice(0, slash) }] : [];
      return [PHONE_HOME, { kind: "settings" }, ...parent, route];
    }
  }
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
