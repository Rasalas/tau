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

export function historySteps(from: PhoneRoute, to: PhoneRoute, readerRoute?: PhoneRoute, readerDepth = 1): HistorySteps {
  const before = routePath(from);
  const after = routePath(to);
  let shared = 0;
  while (shared < before.length && shared < after.length && sameRoute(before[shared]!, after[shared]!)) shared += 1;
  const pops = before.length - shared;
  const rest = after.slice(shared);
  const modal = readerRoute && sameRoute(readerRoute, from) ? readerDepth : 0;
  if (pops === 0) return { back: modal, push: rest };
  if (rest.length === 0) return { back: pops + modal, push: [] };
  return { back: pops - 1 + modal, replace: rest[0]!, push: rest.slice(1) };
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
  const next: Record<string, unknown> = { ...(state && typeof state === "object" ? state as Record<string, unknown> : {}), [STATE_KEY]: route };
  const reader = phoneReaderFromState(state);
  if (reader && !sameRoute(reader.route, route)) delete next[READER_KEY];
  return next;
}

const READER_KEY = "tau.workspace-file-reader";
export interface PhoneReaderEntry { key: string; route: PhoneRoute; depth?: number }

/** The modal belongs to a route, not just a component's surviving marker. */
export function phoneReaderFromState(state: unknown): PhoneReaderEntry | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate: unknown = (state as Record<string, unknown>)[READER_KEY];
  // A reload may retain the earlier string marker. Claim it on its stamped route.
  if (typeof candidate === "string") {
    const route = routeFromState(state);
    return route ? { key: candidate, route } : undefined;
  }
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  const route = routeFromState({ [STATE_KEY]: record.route });
  return typeof record.key === "string" && route ? { key: record.key, route, ...(typeof record.depth === "number" && Number.isInteger(record.depth) && record.depth > 1 ? { depth: record.depth } : {}) } : undefined;
}

export function stateWithPhoneReader(state: unknown, reader: PhoneReaderEntry): Record<string, unknown> {
  return { ...(state && typeof state === "object" ? state as Record<string, unknown> : {}), [READER_KEY]: reader };
}

// One browser history, owned by TouchLayer. Compact dialogs register their lifetime;
// they never navigate from a teardown callback themselves. Nothing here is SDK API.
interface ReaderRegistration { order: number; key: string; hostingRoute?: PhoneRoute; close(): void }
interface ReaderCoordinator { changed(): void; dismiss(key: string): boolean }
const registrations: ReaderRegistration[] = [];
let coordinator: ReaderCoordinator | undefined;
// Batch effect cleanup and registration so replacing a dialog keeps one step.
let changeQueued = false;
function readersChanged(): void {
  if (changeQueued) return;
  changeQueued = true;
  queueMicrotask(() => {
    changeQueued = false;
    coordinator?.changed();
  });
}

export function currentPhoneReaders(): readonly Readonly<ReaderRegistration>[] { return registrations; }
export function currentPhoneReader(): Readonly<ReaderRegistration> | undefined { return registrations.at(-1); }
export function registerPhoneReader(key: string, close: () => void, order: number): () => void {
  const existing = registrations.find((item) => item.key === key);
  if (existing) existing.close = close;
  else {
    registrations.push({ key, close, order });
    registrations.sort((a, b) => a.order - b.order);
  }
  readersChanged();
  return () => {
    const index = registrations.findIndex((item) => item.key === key);
    if (index < 0) return;
    registrations.splice(index, 1);
    readersChanged();
  };
}
export function phoneReaderDepth(key: string): number {
  return registrations.findIndex((item) => item.key === key) + 1;
}
/** Back closes only layers above the entry it reached; route changes close all. */
export function closePhoneReadersAbove(key?: string): void {
  let top = currentPhoneReader();
  while (top && top.key !== key) {
    closePhoneReader(top.key);
    top = currentPhoneReader();
  }
}
/** Bind once after the route settles; a live reader cannot migrate to another route. */
export function claimPhoneReaderRoute(key: string, route: PhoneRoute): boolean {
  const registration = registrations.find((item) => item.key === key);
  if (!registration) return false;
  registration.hostingRoute ??= route;
  return sameRoute(registration.hostingRoute, route);
}
export function closePhoneReader(key: string): void {
  const index = registrations.findIndex((item) => item.key === key);
  if (index < 0) return;
  const [registration] = registrations.splice(index, 1);
  registration!.close();
}
export function coordinatePhoneReaderHistory(owner: ReaderCoordinator): () => void {
  coordinator = owner;
  owner.changed();
  return () => { if (coordinator === owner) coordinator = undefined; };
}
export function dismissPhoneReader(key: string): void {
  if (!coordinator?.dismiss(key)) closePhoneReader(key);
}
