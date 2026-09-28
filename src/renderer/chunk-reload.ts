/**
 * A chunk that no longer loads: the build under an open window was replaced
 * (a host update for a browser tab, a rebuild for a window), so its hashed
 * files are gone. One reload picks up the new build; a marker per build in
 * `sessionStorage` keeps a chunk that is missing for good from looping.
 */

const MARKER_KEY = "tau.chunk-reload";

const CHUNK_ERROR = [
  /Failed to fetch dynamically imported module/iu,
  /error loading dynamically imported module/iu,
  /Importing a module script failed/iu,
  /Failed to load module script/iu,
  /Unable to preload CSS/iu,
  /Loading (CSS )?chunk \S+ failed/iu,
];

export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "ChunkLoadError" || CHUNK_ERROR.some((pattern) => pattern.test(error.message));
}

export interface ChunkRecovery {
  /** Reloads unless this build already did; true when a reload is on its way. */
  reloadOnce(): boolean;
  /** A reload was asked for; the page is about to go. */
  reloading(): boolean;
  /** Reloads now, whatever the marker says: the user asked for it. */
  reload(): void;
}

export function createChunkRecovery(ports: {
  storage: () => Pick<Storage, "getItem" | "setItem">;
  reload: () => void;
  build: () => string;
}): ChunkRecovery {
  let pending = false;
  return {
    reloadOnce() {
      if (pending) return true;
      try {
        const storage = ports.storage();
        const build = ports.build();
        if (storage.getItem(MARKER_KEY) === build) return false;
        storage.setItem(MARKER_KEY, build);
      } catch {
        // Without the marker a reload could not tell it already happened.
        return false;
      }
      pending = true;
      ports.reload();
      return true;
    },
    reloading: () => pending,
    reload() {
      pending = true;
      ports.reload();
    },
  };
}

/** The entry script's hashed URL names the build a page runs. */
function currentBuild(): string {
  const entry = document.querySelector<HTMLScriptElement>("script[type=module][src]");
  return entry?.src ?? window.location.pathname;
}

export const chunkRecovery: ChunkRecovery = createChunkRecovery({
  storage: () => window.sessionStorage,
  reload: () => window.location.reload(),
  build: currentBuild,
});

/**
 * Vite reports every failed chunk of a built page here, the ones no boundary
 * catches included. Swallowed only when the page reloads; otherwise the error
 * goes on to the boundary around it.
 */
export function watchChunkLoadErrors(target: Window = window, recovery: ChunkRecovery = chunkRecovery): () => void {
  const listener = (event: Event) => {
    const error = (event as Event & { payload?: unknown }).payload;
    if (!isChunkLoadError(error)) return;
    console.error("[tau] A chunk failed to load", error);
    // The import then resolves to nothing, which only matters to a page that stays.
    if (recovery.reloadOnce()) event.preventDefault();
  };
  target.addEventListener("vite:preloadError", listener);
  return () => target.removeEventListener("vite:preloadError", listener);
}
