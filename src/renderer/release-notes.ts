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
