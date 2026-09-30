import { createProtocolServer, type SocketHostTransport } from "./host-transport-socket.js";
import type { ConnectListener } from "./host-connect.js";

/** Attach to the host's existing transport so subscriptions, pushes and client calls share one registry. */
export async function openConnectListener(transport: Pick<SocketHostTransport, "attach">, material: { cert: string; key: string; publicKey: string; fingerprint: string }): Promise<ConnectListener> {
  const server = createProtocolServer(material);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const detach = transport.attach(server, "proxy");
  return {
    port: (server.address() as { port: number }).port,
    publicKey: material.publicKey,
    fingerprint: material.fingerprint,
    close: async () => { detach(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
