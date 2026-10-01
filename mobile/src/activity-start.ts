import type { SavedHost, HostBook } from "./hosts";
import type { SocketCandidate } from "./endpoints";
import { socketCandidates } from "./endpoints";
import { connectCandidate } from "./relay-connect";
import type { PushKeys } from "./push-keys";

export interface RemoteActivityStatus { available: boolean; enabled: boolean }
export interface RemoteActivities {
  status(hostId: string): Promise<RemoteActivityStatus>;
  connect(host: SavedHost): Promise<void>;
  setEnabled(host: SavedHost, enabled: boolean): Promise<void>;
  revoke(hostId: string): Promise<void>;
}
export interface RemoteActivityNative {
  status(hostId: string): Promise<RemoteActivityStatus>;
  configure(value: { hostId: string; token: string; candidates: SocketCandidate[]; keyId: string; key: string; enabled?: true }): Promise<void>;
  disable(hostId: string): Promise<void>;
}

/** Separate activity keys keep disabling Live Activities from disabling alerts.
 * Consent originates only in the phone's host settings, never from host events. */
export function remoteActivities(book: HostBook, keys: PushKeys, native: RemoteActivityNative, virtual: boolean): RemoteActivities {
  const revisions = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  function serial(hostId: string, work: () => Promise<void>): Promise<void> {
    const next = (pending.get(hostId) ?? Promise.resolve()).catch(() => undefined).then(work);
    pending.set(hostId, next);
    return next;
  }
  async function configure(host: SavedHost, enabled?: true): Promise<void> {
    const revision = revisions.get(host.id) ?? 0;
    const token = await book.token(host.id);
    if (!token) { await native.disable(host.id); throw new Error("Pair this host before enabling Live Activities."); }
    const pins = { ...(host.publicKey ? { publicKey: host.publicKey } : {}), ...(host.fingerprint ? { fingerprint: host.fingerprint } : {}) };
    const candidates = socketCandidates(host.endpoints, pins, { platform: "ios", virtual }).filter((candidate) => candidate.trust !== "plain");
    const connect = await book.connect(host.id);
    const connected = connect ? connectCandidate(connect, pins) : undefined;
    if (connected) candidates.push(connected);
    const key = await keys.forHost(host.id);
    if (revision !== (revisions.get(host.id) ?? 0) || !(await book.token(host.id))) return;
    await native.configure({ hostId: host.id, token, candidates, ...key, ...(enabled ? { enabled } : {}) });
  }
  return {
    status: (hostId) => native.status(hostId),
    connect: async (host) => {
      const revision = revisions.get(host.id) ?? 0;
      if ((await native.status(host.id)).enabled) await serial(host.id, async () => { if (revision === (revisions.get(host.id) ?? 0)) await configure(host); });
    },
    setEnabled: async (host, enabled) => {
      const revision = (revisions.get(host.id) ?? 0) + 1;
      revisions.set(host.id, revision);
      await serial(host.id, async () => {
        if (revision !== revisions.get(host.id)) return;
        if (enabled) await configure(host, true);
        else { await native.disable(host.id); await keys.forget(host.id); }
      });
    },
    revoke: async (hostId) => {
      revisions.set(hostId, (revisions.get(hostId) ?? 0) + 1);
      await serial(hostId, async () => { await native.disable(hostId); await keys.forget(hostId); });
    },
  };
}
