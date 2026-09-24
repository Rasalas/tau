import { randomUUID } from "node:crypto";
import type { HostClientInfo, HostClientObserver, HostClientTransport, HostPairedDevice } from "./host-extensions.js";

/** What a transport tells the registry about the client that just said hello. */
export interface HostClientAttachment {
  transport: HostClientTransport;
  profile?: string;
  /** A stable key of the transport's own (a `WebContents` id), so a reconnect replaces its predecessor. */
  key?: string;
}

/**
 * Who is attached to this host. Every transport reports its clients here, so
 * the seam answers one question — is anybody watching, and how many — without
 * knowing that Electron IPC and a socket are different things.
 */
export class HostClientRegistry {
  private readonly clients = new Map<string, HostClientInfo>();
  private readonly byKey = new Map<string, string>();
  private readonly observers = new Set<HostClientObserver>();
  private deviceSource: () => readonly HostPairedDevice[] = () => [];
  private deviceKey = "";

  constructor(private readonly onChange?: (count: number) => void) {}

  observe(observer: HostClientObserver): () => void {
    this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  }

  count(): number {
    return this.clients.size;
  }

  list(): readonly HostClientInfo[] {
    return [...this.clients.values()];
  }

  /** The paired devices, from the host's access store once it is open. */
  devices(): readonly HostPairedDevice[] {
    return this.deviceSource();
  }

  setDeviceSource(source: () => readonly HostPairedDevice[]): void {
    this.deviceSource = source;
    this.devicesChanged();
  }

  /** The access store changed; observers hear of it only when the device list did. */
  devicesChanged(): void {
    const key = JSON.stringify(this.deviceSource().map((device) => [device.id, device.name, device.access]));
    if (key === this.deviceKey) return;
    this.deviceKey = key;
    for (const observer of [...this.observers]) observer.devicesChanged?.();
  }

  /** Records a client and answers with the id the host will know it by. */
  attached(attachment: HostClientAttachment): string {
    if (attachment.key !== undefined) {
      const previous = this.byKey.get(attachment.key);
      if (previous !== undefined) this.detached(previous);
    }
    const id = randomUUID();
    const client: HostClientInfo = {
      id,
      transport: attachment.transport,
      ...(attachment.profile ? { profile: attachment.profile } : {}),
    };
    this.clients.set(id, client);
    if (attachment.key !== undefined) this.byKey.set(attachment.key, id);
    for (const observer of [...this.observers]) observer.attached?.(id, client);
    this.onChange?.(this.clients.size);
    return id;
  }

  /** Repeated calls for one client are ignored: a socket reports close and error both. */
  detached(clientId: string): void {
    if (!this.clients.delete(clientId)) return;
    for (const [key, id] of this.byKey) if (id === clientId) this.byKey.delete(key);
    for (const observer of [...this.observers]) observer.detached?.(clientId);
    this.onChange?.(this.clients.size);
  }
}
