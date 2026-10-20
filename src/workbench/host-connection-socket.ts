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
      ?? (() => connection?.refuse("This machine does not accept connections from this page’s address. Open Tau from the machine’s own address instead.")),
  });
  connection = new HostConnection(transport);
  const client = createHostClient(connection, local);
  if (local) return { client, connection };
  // A page without a native window cannot issue actions against the host's window.
  const windowAction = async (): Promise<never> => { throw new HostRequestError("This client has no window of its own.", HOST_ERROR.unsupported); };
  return { client: { ...client, windowAction }, connection };
}
