import { HostConnection, HostRequestError } from "./host-connection";
import { createHostClient, type HostClient } from "./host-client";
import { HOST_ERROR } from "../shared/host-transport";
import { createSocketHostTransport, type SocketTransportOptions } from "../shared/socket-host-transport";
export * from "../shared/socket-host-transport";

/**
 * A host client that talks to a host over a socket instead of through Electron.
 * `local` is the client's own machine, when it has one: a desktop window whose
 * host runs in another process keeps answering `CLIENT_SIDE_METHODS` there.
 */
export function createSocketHostClient(
  url: string,
  token?: string,
  options?: SocketTransportOptions,
  local?: HostConnection,
): { client: HostClient; connection: HostConnection } {
  let connection: HostConnection | undefined = undefined;
  const transport = createSocketHostTransport(url, token, {
    ...options,
    onOriginRefused: options?.onOriginRefused
      ?? (() => connection?.refuse("This host does not accept connections from this page's address. Open the client from the host's own address, or add this one to TAU_HOST_ALLOWED_ORIGINS on the host.")),
  });
  connection = new HostConnection(transport);
  const client = createHostClient(connection, local);
  if (local) return { client, connection };
  // A page without a window process (a browser tab, the app) has no window to act on, and asking
  // the host would count as a change a paired device made.
  const windowAction = async (): Promise<never> => { throw new HostRequestError("This client has no window of its own.", HOST_ERROR.unsupported); };
  return { client: { ...client, windowAction }, connection };
}
