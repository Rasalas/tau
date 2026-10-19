/** What the install tool's two halves agree on: the card waiting above a thread's composer. */
export const INSTALL_TOOL = "tau_install_package";
export const INSTALL_REQUESTS_EVENT = "install-requests";

export type InstallRequestStatus = "pending" | "running" | "declined" | "ended";

/** One package the agent asked to install, waiting for the user's answer. */
export interface InstallRequest {
  id: string;
  threadId: string;
  status: InstallRequestStatus;
  /** The manifest's id; a link to the package's page in Settings → Extensions. */
  packageId: string;
  name: string;
  version?: string;
  description?: string;
  permissions: string[];
  isolation: "worker" | "in-process";
}

/** `install-requests`: what waits, and whether this connection may answer it. */
export interface InstallRequestList {
  requests: InstallRequest[];
  canManage: boolean;
}

export function readInstallRequests(value: unknown): InstallRequest[] {
  const list = Array.isArray(value) ? value : (value as { requests?: unknown } | undefined)?.requests;
  return Array.isArray(list)
    ? list.filter((entry): entry is InstallRequest => Boolean(entry) && typeof entry === "object" && typeof (entry as InstallRequest).id === "string" && typeof (entry as InstallRequest).threadId === "string")
    : [];
}
