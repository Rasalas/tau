/** What the install tool's two halves agree on: the card waiting above a thread's composer. */
export const INSTALL_TOOL = "tau_install_package";
export const INSTALL_REQUESTS_EVENT = "install-requests";
/** Published when a package starts without a card, for the toast with its "Turn off". */
export const PACKAGE_STARTED_EVENT = "package-started";

/** What `package-started` carries. */
export interface PackageStarted {
  threadId: string;
  packageId: string;
  name: string;
  isolation: "worker" | "in-process";
}

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
  /** The package draws in Tau's window. */
  desktop: boolean;
  host: boolean;
  /** What the user allowed before; the card asks only about what is new. */
  previous?: { permissions: string[]; isolation: "worker" | "in-process"; desktop?: boolean; host?: boolean };
}

/** `install-requests`: what waits, and whether this connection may answer it. */
export interface InstallRequestList {
  requests: InstallRequest[];
  canManage: boolean;
}

export function readPackageStarted(value: unknown): PackageStarted | undefined {
  const fields = value && typeof value === "object" ? value as Partial<PackageStarted> : {};
  return typeof fields.packageId === "string" && typeof fields.name === "string" && typeof fields.threadId === "string"
    ? { threadId: fields.threadId, packageId: fields.packageId, name: fields.name, isolation: fields.isolation === "in-process" ? "in-process" : "worker" }
    : undefined;
}

export function readInstallRequests(value: unknown): InstallRequest[] {
  const list = Array.isArray(value) ? value : (value as { requests?: unknown } | undefined)?.requests;
  return Array.isArray(list)
    ? list.filter((entry): entry is InstallRequest => Boolean(entry) && typeof entry === "object" && typeof (entry as InstallRequest).id === "string" && typeof (entry as InstallRequest).threadId === "string")
    : [];
}
