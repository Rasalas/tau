import { useEffect, useState } from "react";
import type { ReleaseNotes } from "../shared/window-shell";
import { useHostClient } from "./host-client-context";

export type NotesView = { state: "loading" } | { state: "unavailable" } | { state: "ready"; releases: ReleaseNotes[] };

export function useReleaseNotes(version: string | undefined, fromVersion?: string, enabled = true, attempt = 0): NotesView {
  const client = useHostClient();
  const [result, setResult] = useState<{ key: string; view: NotesView }>();
  const key = `${version}:${fromVersion}:${attempt}`;
  useEffect(() => {
    if (!client || !version || !enabled) return;
    let live = true;
    void client.windowAction({ kind: "release-notes", version, ...(fromVersion ? { fromVersion } : {}) })
      .catch(() => client.releaseNotes(version, fromVersion)).catch(() => [])
      .then((value) => {
        if (!live) return;
        const releases = Array.isArray(value) ? value.filter((entry): entry is ReleaseNotes => Boolean(entry && typeof entry.version === "string" && Array.isArray(entry.items) && entry.items.every((item: unknown) => typeof item === "string") && typeof entry.totalItems === "number")) : [];
        setResult({ key, view: releases.length ? { state: "ready", releases } : { state: "unavailable" } });
      });
    return () => { live = false; };
  }, [client, version, fromVersion, enabled, key]);
  if (!client || !version) return { state: "unavailable" };
  return result?.key === key ? result.view : { state: "loading" };
}
