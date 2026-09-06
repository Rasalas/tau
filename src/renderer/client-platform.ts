import type { ClientStorage } from "../workbench/client-storage";
import type { HostClient } from "../workbench/host-client";
import type { Platform } from "../workbench/platform";

/**
 * What the workbench knows when it builds its `Platform`, and all it knows: a
 * client, the key-value store it was booted with, and the two questions whose
 * answers only the running registry and the settled hello can give.
 */
export interface ClientPlatformPorts {
  /** Absent in the browser preview, where there is no host at all. */
  client?: HostClient;
  storage: ClientStorage;
  /** Who opens a path in the user's editor; the registered document source, when there is one. */
  openInEditor(path: string): void;
  /** Whether the host's files are files of this machine (`local-files`). */
  hasLocalFiles(): boolean;
}

export type ClientPlatformFactory = (ports: ClientPlatformPorts) => Platform;
