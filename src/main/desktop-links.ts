import { parsePromptLink, promptLinkParams } from "../shared/prompt-links.js";

const pending: string[] = [];
const listeners = new Set<() => void>();

export function receiveDesktopLink(url: string): boolean {
  const link = parsePromptLink(url);
  if (!link) return false;
  const params = promptLinkParams(link);
  if (link.hostId) params.set("host", link.hostId);
  // Bound queued OS input while no workbench is mounted.
  pending.push(`tau://new?${params}`);
  if (pending.length > 10) pending.shift();
  for (const listener of listeners) listener();
  return true;
}

export function takeDesktopLinks(): string[] { return pending.splice(0); }
export function onDesktopLink(listener: () => void): void { listeners.add(listener); }
