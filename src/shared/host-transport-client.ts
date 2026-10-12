import type { HostPush, HostResponse } from "./host-transport.js";
import type { HostLink } from "./host-link.js";

/** Frames and lifecycle shared by the renderer and the window process. */
export interface HostTransport {
  readonly platform: string;
  resourceUrl?(path: string): string;
  request(method: string, params: readonly unknown[]): Promise<HostResponse>;
  onPush(listener: (push: HostPush) => void): () => void;
  onOpen?(listener: () => void): () => void;
  onClose?(listener: () => void): () => void;
  close?(): void;
  getLink?(): HostLink;
  onLink?(listener: (link: HostLink) => void): () => void;
  retryNow?(): void;
  updateToken?(token: string): void;
}
