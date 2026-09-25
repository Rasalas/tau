import type { HostEvent } from "../shared/contracts";
import type { UiDiscoveredHosts } from "../shared/discovery";
import type {
  EnvironmentAgentsResult,
  EnvironmentOpenTarget,
  EnvironmentPairInput,
  EnvironmentPairResult,
  EnvironmentPreferences,
  EnvironmentTarget,
  UiEnvironmentThreadView,
  UiEnvironments,
} from "../shared/environments";
import type { TranscriptPage } from "../shared/host-protocol";
import type { HostTranscriptCursor } from "../shared/transcript-cursor";
import type { HostClient } from "./host-client";

/** How often an open look-in renews its watch; the window lets one go after a minute without. */
export const LOOK_IN_RENEW_MS = 20_000;

/**
 * The machines this window knows (ADR 0025), as a page reads them: a list
 * that follows the window's own process, and the few things it can ask of
 * it. Absent in a client without a window process (a browser, a phone), and
 * `getSnapshot` stays undefined where the window keeps no list.
 */
export interface PlatformEnvironments {
  /**
   * The machine this page shows when it is not the window's own, from the
   * page's address: known before the list loads, and whatever kits that
   * machine serves (API 1.13.0).
   */
  readonly shownElsewhere?: string;
  getSnapshot(): UiEnvironments | undefined;
  subscribe(listener: () => void): () => void;
  /** A pairing link, QR text or address; resolves once the other machine's owner decided. */
  pair(input: EnvironmentPairInput): Promise<EnvironmentPairResult>;
  cancelPairing(): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Tries to reach a machine now instead of at its next attempt. */
  retry(id: string): Promise<void>;
  /**
   * Shows another machine in this window: the page loads again there and
   * opens `target`. For the machine already shown, open the target directly.
   * `{ threadId }` names a thread by its id there, which the window finds in
   * that machine's index (API 1.15.0).
   */
  open(id: string, target?: EnvironmentOpenTarget): Promise<void>;
  /** What this page was sent to show, once; undefined when it was simply opened. */
  takeArrival(): Promise<EnvironmentTarget | undefined>;
  /** Shows the window's own machine again (API 1.13.0). */
  showLocal(): Promise<void>;
  /**
   * Machines that announce themselves on this network, looked for by the
   * window's own host for a few seconds; `pair({ nearby: hostId })` adds one.
   * A saved machine found there gets its current addresses (API 1.13.0).
   */
  discover(): Promise<UiDiscoveredHosts>;
  setPreferences(preferences: EnvironmentPreferences): Promise<void>;
  /**
   * Lets this computer's agents work on a saved machine, or stops them (ADR
   * 0027). On asks that machine's owner once more, for the agents alone, and
   * shows the digits as `pairing`. New in API 1.15.0.
   */
  setAgents?(id: string, on: boolean): Promise<EnvironmentAgentsResult>;
  /**
   * Follows a thread of a machine (its host id, or its unique name) over the
   * window's own connection to it, without showing that machine: the
   * listener hears what the machine's index says of the thread and whether
   * the window reaches it, at once and at every change. While any listener
   * is left, that connection receives the thread's stream. New in API 1.15.0.
   */
  watchThread?(machine: string, sessionId: string, listener: (view: UiEnvironmentThreadView) => void): () => void;
  /** The newest page of that thread's transcript, or the one before `cursor`; again at every new `revision`. New in API 1.15.0. */
  transcriptPage?(machine: string, sessionId: string, cursor?: HostTranscriptCursor): Promise<TranscriptPage>;
  /**
   * Runs a kit's host command on a machine without showing it, over the
   * window's own connection there: only a command that kit registered
   * `access: "read"`, so a look-in can watch but never change anything
   * (a picture of that machine's Preview, say). New in API 1.15.0.
   */
  readExtension?(machine: string, extensionId: string, command: string, input?: unknown): Promise<unknown>;
}

interface LookIn {
  machine: string;
  sessionId: string;
  /** The machine's id as the window answered it; the page may have named it. */
  resolved?: string;
  listeners: Set<(view: UiEnvironmentThreadView) => void>;
  timer?: ReturnType<typeof setInterval>;
  last?: UiEnvironmentThreadView;
}

/** One lease per thread, whatever number of tabs and labels read it. */
function createLookIns(client: HostClient) {
  const lookIns = new Map<string, LookIn>();
  let listening = false;
  const deliver = (entry: LookIn, view: UiEnvironmentThreadView) => {
    entry.resolved = view.machine;
    entry.last = view;
    for (const listener of [...entry.listeners]) listener(view);
  };
  const renew = (entry: LookIn) => {
    void client.watchEnvironmentThread(entry.machine, entry.sessionId, true).then((view) => {
      if (view && entry.listeners.size > 0) deliver(entry, view);
    }, () => undefined);
  };
  return (machine: string, sessionId: string, listener: (view: UiEnvironmentThreadView) => void): (() => void) => {
    if (!listening) {
      listening = true;
      client.onHostEvent((event) => {
        if (event.type !== "environment-thread") return;
        for (const entry of lookIns.values()) {
          if (entry.sessionId === event.view.sessionId && (entry.resolved ?? entry.machine) === event.view.machine) deliver(entry, event.view);
        }
      });
    }
    const key = `${machine}\n${sessionId}`;
    let entry = lookIns.get(key);
    if (!entry) {
      const created: LookIn = { machine, sessionId, listeners: new Set() };
      created.timer = setInterval(() => renew(created), LOOK_IN_RENEW_MS);
      lookIns.set(key, created);
      entry = created;
      renew(created);
    } else if (entry.last) listener(entry.last);
    entry.listeners.add(listener);
    const current = entry;
    return () => {
      if (!current.listeners.delete(listener) || current.listeners.size > 0) return;
      clearInterval(current.timer);
      lookIns.delete(key);
      void client.watchEnvironmentThread(machine, sessionId, false).catch(() => undefined);
    };
  };
}

export function createPlatformEnvironments(client: HostClient, options: { shownElsewhere?: string } = {}): PlatformEnvironments {
  let snapshot: UiEnvironments | undefined;
  let requested = false;
  const listeners = new Set<() => void>();
  const watchThread = createLookIns(client);
  const set = (next: UiEnvironments) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  // Nothing is asked or listened to until something reads the list.
  const load = () => {
    if (requested) return;
    requested = true;
    client.onHostEvent((event: HostEvent) => {
      if (event.type === "environments") set(event.environments);
    });
    // A window without a list refuses; the page then simply shows no other machines.
    void client.listEnvironments().then((list) => { if (!snapshot) set(list); }, () => undefined);
  };
  return {
    ...(options.shownElsewhere ? { shownElsewhere: options.shownElsewhere } : {}),
    getSnapshot: () => {
      load();
      return snapshot;
    },
    subscribe: (listener) => {
      load();
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    pair: (input) => client.pairEnvironment(input),
    cancelPairing: () => client.cancelEnvironmentPairing(),
    rename: async (id, name) => { await client.renameEnvironment(id, name); },
    remove: async (id) => { await client.removeEnvironment(id); },
    retry: (id) => client.retryEnvironment(id),
    open: (id, target) => client.openEnvironment(id, target),
    takeArrival: () => client.takeEnvironmentArrival(),
    showLocal: async () => {
      const list = snapshot ?? await client.listEnvironments();
      const local = list.environments.find((environment) => environment.local);
      if (!local) throw new Error("This window knows no machine of its own.");
      await client.openEnvironment(local.id);
    },
    discover: () => client.discoverEnvironments(),
    setPreferences: (preferences) => client.setEnvironmentPreferences(preferences),
    setAgents: (id, on) => client.setEnvironmentAgents(id, on),
    watchThread,
    transcriptPage: (machine, sessionId, cursor) => client.loadEnvironmentTranscript(machine, sessionId, cursor),
    readExtension: (machine, extensionId, command, input) => client.readEnvironmentExtension(machine, extensionId, command, input),
  };
}
