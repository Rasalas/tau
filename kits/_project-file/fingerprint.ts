import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(fields).sort().map((key) => [key, canonical(fields[key])]));
  }
  return value;
}

/** Hash the definitions, not formatting or unrelated project metadata. */
export function setupFingerprint(text: string): string {
  const raw = JSON.parse(text) as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(canonical([
    raw.workspaceMode, raw.worktreeDirectory, raw.runOnWorktreeCreate, raw.scripts,
  ]))).digest("hex");
}
