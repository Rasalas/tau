import type { HostMethodDeps } from "./host-methods.js";
import type { PiHost } from "./pi-host.js";

/**
 * The host of a host process, started once by the first call that needs it.
 * A client's first call is not always `bootstrap`: a window asks for its
 * themes and kit bundles beside it, over two connections, in no fixed order.
 * Each of those waits for the one start instead of failing (ADR 0021).
 */
export class HostStart {
  private host: PiHost | undefined;
  private ready: Promise<unknown> | undefined;

  constructor(private readonly create: () => PiHost) {}

  /** The host once it has started; a failed start rejects every caller with its error. */
  async require(): Promise<PiHost> {
    if (!this.host) {
      this.host = this.create();
      this.ready = this.host.start();
    }
    await this.ready;
    return this.host;
  }

  /** The host as it is, started or not, for calls that must not wait for it. */
  current(): PiHost | undefined {
    return this.host;
  }

  /** The part of the method table's dependencies that is the host. */
  methodDeps(): Pick<HostMethodDeps, "bootstrap" | "requireHost" | "host"> {
    return {
      bootstrap: async () => (await this.require()).bootstrap(),
      requireHost: () => this.require(),
      host: () => this.current(),
    };
  }
}
