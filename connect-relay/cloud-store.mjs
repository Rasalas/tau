import { randomUUID } from "node:crypto";
import { createFirestoreDocument } from "./firestore.mjs";
import { validateRoutes } from "./route-store.mjs";

// A process stops forwarding 15s before a replacement can acquire the 45s lease.
const LEASE_MS = 45_000;
const SAFE_MS = 30_000;
const RENEW_MS = 15_000;

export function createCloudRouteStore({ project, database, revision, document = createFirestoreDocument({ project, database }), now = Date.now }) {
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(revision ?? "")) throw new Error("Cloud storage requires K_REVISION.");
  const owner = randomUUID();
  let routes = {};
  let until = 0;
  let refreshed = 0;
  let closed = false;
  let inflight;
  let expiration;
  let queue = Promise.resolve();
  const serial = (operation) => {
    const task = queue.then(operation);
    queue = task.catch(() => {});
    return task;
  };
  let onUnavailable = () => {};
  let onRoutesChanged = () => {};
  const ready = () => !closed && now() < until;
  const unavailable = () => { until = 0; clearTimeout(expiration); onUnavailable(); };
  const publish = (state) => { routes = validateRoutes(state.routes); onRoutesChanged(routes); };
  const owns = (state, time) => state.allowedRevision === revision && state.lease?.owner === owner && state.lease.until > time;
  const refresh = () => {
    if (closed) return Promise.resolve(false);
    if (inflight) return inflight;
    const started = now();
    inflight = serial(() => document.update((state, time) => {
      validateRoutes(state.routes);
      state.allowedRevision ??= revision;
      if (state.allowedRevision !== revision || (state.lease && state.lease.owner !== owner && state.lease.until > time)) return false;
      state.lease = { owner, revision, until: time + LEASE_MS };
      return true;
    }).then(({ state, result }) => {
      if (!result || closed || now() >= started + SAFE_MS) { unavailable(); return false; }
      publish(state);
      until = started + SAFE_MS;
      refreshed = started;
      clearTimeout(expiration);
      expiration = setTimeout(unavailable, Math.max(1, until - now()));
      expiration.unref();
      return true;
    }).catch(() => { unavailable(); return false; })).finally(() => { inflight = undefined; });
    return inflight;
  };
  const change = async (mutate) => {
    if (!await ensureReady()) throw new Error("Relay lease is unavailable.");
    return serial(async () => {
      try {
        const { state, result } = await document.update((state, time) => {
          if (!owns(state, time)) throw new Error("Relay lease was lost.");
          validateRoutes(state.routes);
          return mutate(state.routes);
        });
        publish(state);
        return result;
      } catch (error) { unavailable(); throw error; }
    });
  };
  const ensureReady = async () => ready() && now() - refreshed < RENEW_MS ? true : refresh();
  const timer = setInterval(() => { if (ready()) void refresh(); }, RENEW_MS);
  timer.unref();
  return {
    ready, ensureReady, snapshot: () => routes,
    subscribe(callbacks) { onUnavailable = callbacks.onUnavailable; onRoutesChanged = callbacks.onRoutesChanged; },
    add: (id, record, limit) => change((next) => {
      if (Object.keys(next).length >= limit) return false;
      next[id] = record;
      return true;
    }),
    remove: (id) => change((next) => {
      if (!next[id]) return false;
      delete next[id];
      return true;
    }),
    close() { closed = true; clearInterval(timer); unavailable(); },
  };
}
