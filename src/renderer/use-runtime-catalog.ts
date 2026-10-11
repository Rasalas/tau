import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { HostSnapshot, ThreadBackendKind, UiComposerCommand } from "../shared/contracts";
import type { NewThreadDraft } from "../workbench/draft-store";
import type { HostClient } from "../workbench/host-client";
import { RuntimeAvailabilityStore, withDisabledRuntimes } from "../workbench/runtime-availability-store";
import { RuntimeCatalogStore, type RuntimeCatalogEntry } from "../workbench/runtime-catalog-store";
import { useHostClient } from "./host-client-context";

const stores = new WeakMap<HostClient, RuntimeCatalogStore>();
const idle = () => () => undefined;
const NONE: ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry> = new Map();

/** One store per client, following the host's catalog events for as long as the client lives. */
export function runtimeCatalogStore(client: HostClient | undefined): RuntimeCatalogStore | undefined {
  if (!client) return undefined;
  let store = stores.get(client);
  if (!store) {
    const created = store = new RuntimeCatalogStore(client);
    client.onHostEvent((event) => { if (event.type === "runtime-catalog") created.apply(event.catalog); });
    stores.set(client, store);
  }
  return store;
}

/** What `kind` offers a thread that does not exist yet; asked of the host while a draft is bound for it. */
export function useRuntimeCatalog(kind: ThreadBackendKind | undefined): RuntimeCatalogEntry | undefined {
  const store = runtimeCatalogStore(useHostClient());
  useEffect(() => { if (kind) store?.request(kind); }, [kind, store]);
  return useSyncExternalStore(store?.subscribe ?? idle, () => (kind ? store?.get(kind) : undefined));
}

/**
 * Every runtime's catalog while `open` (a picker is open): opening fetches what
 * is missing and has the host revalidate; closed, nothing re-renders for them.
 */
export function useRuntimeCatalogs(open: boolean): ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry> {
  const client = useHostClient();
  const store = open ? runtimeCatalogStore(client) : undefined;
  useEffect(() => { void store?.refresh(); }, [store]);
  return useSyncExternalStore(store?.subscribe ?? idle, () => store?.all() ?? NONE);
}

/**
 * A model's name as its runtime's catalog lists it (API 1.23.0): asks for that
 * catalog once, and answers nothing until it is in or where it has no such model.
 */
export function useModelName(kind: ThreadBackendKind | undefined, model: string | undefined, provider?: string): string | undefined {
  const entry = useRuntimeCatalog(model ? kind : undefined);
  const models = entry && entry.status !== "loading" ? entry.catalog?.models : undefined;
  if (!model || !models) return undefined;
  return (models.find((item) => item.id === model && (!provider || item.provider === provider)) ?? models.find((item) => item.id === model))?.name;
}

const availabilities = new WeakMap<HostClient, RuntimeAvailabilityStore>();
const NO_KINDS: readonly string[] = [];

/** One store per client, asked again whenever the host's config changes. */
export function runtimeAvailabilityStore(client: HostClient | undefined): RuntimeAvailabilityStore | undefined {
  if (!client) return undefined;
  let store = availabilities.get(client);
  if (!store) {
    const created = store = new RuntimeAvailabilityStore(client);
    client.onHostEvent((event) => { if (event.type === "config-changed") created.refresh(); });
    availabilities.set(client, store);
  }
  return store;
}

/**
 * The snapshot with the runtimes the project of `workspaceId` turned off marked
 * `disabled` (ADR 0033); `workspaceId` is the draft's project while one is on screen.
 */
export function useOfferedRuntimes(snapshot: HostSnapshot | undefined, workspaceId: string | undefined): HostSnapshot | undefined {
  const store = runtimeAvailabilityStore(useHostClient());
  useEffect(() => { store?.request(workspaceId); }, [store, workspaceId]);
  const disabled = useSyncExternalStore(store?.subscribe ?? idle, () => store?.disabled(workspaceId) ?? NO_KINDS);
  return useMemo(() => withDisabledRuntimes(snapshot, disabled), [snapshot, disabled]);
}

/**
 * A new thread's draft shows the snapshot of the thread on screen, whose
 * skills belong to that thread's project and runtime. For a draft of another
 * project or runtime the composer lists what the host says that one offers
 * (API 1.59.0, `composer-commands`); until it answers, only the commands that
 * are not skills, so a skill of the wrong project is never offered.
 */
export function useDraftCommands(
  snapshot: HostSnapshot | undefined,
  draft: NewThreadDraft | undefined,
  runtime: ThreadBackendKind | undefined,
): HostSnapshot | undefined {
  const client = useHostClient();
  const workspace = draft?.workspaceId ?? draft?.projectPath;
  const own = Boolean(draft?.workspaceId && draft.workspaceId === snapshot?.workspaceId) && (runtime ?? "pi") === (snapshot?.backendKind ?? "pi");
  const key = !draft || draft.sessionId || own || !workspace || !runtime ? undefined : `${runtime}\u0000${workspace}`;
  const [loaded, setLoaded] = useState<{ key: string; commands: UiComposerCommand[] }>();
  useEffect(() => {
    if (!key || !client) return undefined;
    let current = true;
    const [kind, where] = key.split("\u0000") as [ThreadBackendKind, string];
    client.composerCommands(kind, where).then(
      (commands) => { if (current) setLoaded({ key, commands }); },
      () => { if (current) setLoaded({ key, commands: [] }); },
    );
    return () => { current = false; };
  }, [client, key]);
  const sameRuntime = (runtime ?? "pi") === (snapshot?.backendKind ?? "pi");
  return useMemo(() => {
    if (!snapshot || !key || !client) return snapshot;
    const own = snapshot.composerCommands ?? [];
    const commands = loaded?.key === key
      ? [...own.filter((command) => sameRuntime && command.source !== "skill"), ...loaded.commands.filter((command) => !sameRuntime || command.source === "skill")]
      : own.filter((command) => sameRuntime && command.source !== "skill");
    return { ...snapshot, composerCommands: commands };
  }, [client, key, loaded, sameRuntime, snapshot]);
}
