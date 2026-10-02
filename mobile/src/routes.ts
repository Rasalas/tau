/**
 * Where the app is, in its own address, so a reload or a link lands in the
 * same place: `?host=<id>` is a host's workbench (with the workbench's own
 * `thread=` and `page=`), `?view=add` adds one, anything else is the host list.
 */
export type AppRoute =
  | { view: "workbench"; hostId: string; threadId?: string; page?: string }
  | { view: "add"; text?: string }
  | { view: "hosts"; explicit: boolean };

export function readRoute(search: string): AppRoute {
  const params = new URLSearchParams(search);
  const hostId = params.get("host");
  if (hostId) {
    const threadId = params.get("thread");
    const page = params.get("page");
    return { view: "workbench", hostId, ...(threadId ? { threadId } : {}), ...(page ? { page } : {}) };
  }
  if (params.get("view") === "add") return { view: "add" };
  return { view: "hosts", explicit: params.get("view") === "hosts" };
}

export function routeSearch(route: AppRoute): string {
  switch (route.view) {
    case "workbench": {
      const params = new URLSearchParams({ host: route.hostId });
      if (route.threadId) params.set("thread", route.threadId);
      if (route.page) params.set("page", route.page);
      return `?${params.toString()}`;
    }
    case "add": return "?view=add";
    case "hosts": return route.explicit ? "?view=hosts" : "";
  }
}

/**
 * A link into the app from outside: `tau://thread?host=<id>&thread=<id>`, as
 * a push notification (F08), a widget or another app opens it, and
 * `tau://usage?host=<id>` (the Plan limits widget). It only ever opens a
 * host this phone already paired with; it never pairs and never carries a
 * token or a code.
 */
export function linkRoute(url: string): AppRoute | undefined {
  if (url.startsWith("tau-connect:")) return { view: "add", text: url };
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== "tau:") return undefined;
  const target = parsed.hostname || parsed.pathname.replace(/^\/+/u, "");
  if (target === "hosts") return { view: "hosts", explicit: true };
  const hostId = parsed.searchParams.get("host");
  if (target === "usage" && hostId) return { view: "workbench", hostId, page: "usage" };
  if (target !== "thread" || !hostId) return undefined;
  const threadId = parsed.searchParams.get("thread");
  return { view: "workbench", hostId, ...(threadId ? { threadId } : {}) };
}
