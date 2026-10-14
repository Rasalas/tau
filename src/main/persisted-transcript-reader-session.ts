import { migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";

/**
 * Read-only Pi branch selection. Pi's parser and migrations remain authoritative;
 * constructing SessionManager would also initialize the runtime's config and I/O.
 * The final non-header entry is the leaf, and duplicate ids resolve to the last
 * entry, exactly as SessionManager._buildIndex/getBranch do.
 */
export function readPersistedSessionBranch(text: string): readonly unknown[] {
  const entries = parseSessionEntries(text);
  const header = entries[0] as { type?: unknown; id?: unknown } | undefined;
  if (header?.type !== "session" || typeof header.id !== "string") throw new Error("Invalid Pi session header");
  migrateSessionEntries(entries);
  const byId = new Map<string, (typeof entries)[number]>();
  let leaf: string | null = null;
  for (const entry of entries) {
    if (entry.type === "session") continue;
    byId.set(entry.id, entry);
    leaf = entry.id;
  }
  const branch: unknown[] = [];
  const seen = new Set<string>();
  let current = leaf ? byId.get(leaf) : undefined;
  while (current && current.type !== "session") {
    if (seen.has(current.id)) throw new Error("Pi session branch contains a cycle");
    seen.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}
