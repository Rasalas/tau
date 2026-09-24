import type { HostClient } from "../../src/workbench/host-client";
import type { SavedHost } from "./hosts";

/**
 * Where push notifications (F08) plug in. The app calls `register` once a
 * host's workbench is connected; an implementation asks the platform for an
 * APNs or FCM token and hands it to that host, which sends directly (plan,
 * decision 3). A tap on a notification opens `tau://thread?host=…&thread=…`,
 * which `routes.ts` already routes. Nothing registers yet.
 */
export interface PushRegistrar {
  register(context: { host: SavedHost; client: HostClient }): Promise<void>;
}

let registrar: PushRegistrar | undefined;

export function setPushRegistrar(next: PushRegistrar | undefined): void {
  registrar = next;
}

export function pushRegistrar(): PushRegistrar | undefined {
  return registrar;
}
