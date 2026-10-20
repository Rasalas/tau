import { useEffect, useState } from "react";
import type { ReleaseNotes } from "../shared/window-shell";
import type { HostClient } from "../workbench/host-client";
import { useHostClient } from "./host-client-context";

export type NotesView = { state: "loading" } | { state: "unavailable" } | { state: "ready"; releases: ReleaseNotes[] };
const caches = new WeakMap<HostClient, Map<string, Promise<ReleaseNotes[]>>>();
const openers = new Set<(version: string) => void>();
const updateOpeners = new Set<() => void>();

export function openUpdates(): boolean {
  for (const open of updateOpeners) open();
  return updateOpeners.size > 0;
}

export function onOpenUpdates(open: () => void): () => void {
  updateOpeners.add(open);
  return () => { updateOpeners.delete(open); };
}

/** All update surfaces use this navigation; a window without a sidebar keeps its existing dialog. */
export function openReleaseNotes(version: string): boolean {
  for (const open of openers) open(version);
  return openers.size > 0;
}

export function onOpenReleaseNotes(open: (version: string) => void): () => void {
  openers.add(open);
  return () => { openers.delete(open); };
}

function read(client: HostClient, version: string, fromVersion?: string): Promise<ReleaseNotes[]> {
  let cache = caches.get(client);
  if (!cache) { cache = new Map(); caches.set(client, cache); }
  const key = `${fromVersion ?? ""}:${version}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = client.windowAction({ kind: "release-notes", version, ...(fromVersion ? { fromVersion } : {}) }).then((value) => {
      const releases = Array.isArray(value) ? value.filter((entry): entry is ReleaseNotes => Boolean(entry && typeof entry.version === "string" && Array.isArray(entry.items) && entry.items.every((item: unknown) => typeof item === "string") && typeof entry.totalItems === "number")) : [];
      if (!releases.length) cache!.delete(key);
      return releases;
    }).catch(() => { cache!.delete(key); return []; });
    if (cache.size > 24) cache.delete(cache.keys().next().value!);
    cache.set(key, pending);
  }
  return pending;
}

export function useReleaseNotes(version: string | undefined, fromVersion?: string, enabled = true, attempt = 0): NotesView {
  const client = useHostClient();
  const [result, setResult] = useState<{ key: string; view: NotesView }>();
  const key = `${version}:${fromVersion}:${attempt}`;
  useEffect(() => {
    if (!client || !version || !enabled) return;
    let live = true;
    void read(client, version, fromVersion).then((releases) => {
      if (live) setResult({ key, view: releases.length ? { state: "ready", releases } : { state: "unavailable" } });
    });
    return () => { live = false; };
  }, [client, version, fromVersion, enabled, key]);
  if (!client || !version) return { state: "unavailable" };
  return result?.key === key ? result.view : { state: "loading" };
}
