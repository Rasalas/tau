import type { HostClientTransport } from "./host-extensions.js";

/**
 * What a transport tells the host about its clients. `HostClientRegistry`
 * implements it; naming only these two keeps a transport free of the registry
 * and of the host behind it.
 */
export interface HostClientSink {
  /** Answers with the id the host will know this client by. */
  attached(client: { transport: HostClientTransport; profile?: string; key?: string }): string;
  detached(clientId: string): void;
}
