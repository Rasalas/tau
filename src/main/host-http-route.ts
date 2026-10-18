import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { ListenerTrust } from "./host-local-files.js";

/** A host-owned route claims a response before the listener's static fallback. */
export type HostHttpRoute = (request: IncomingMessage, response: ServerResponse, trust: ListenerTrust) => Promise<boolean>;

const protocolOnly: RequestListener = (_request, response) => {
  response.writeHead(426, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  response.end("This port speaks the Tau host protocol over WebSocket.");
};

export function hostHttpListener(route: HostHttpRoute | undefined, trust: ListenerTrust, fallback: RequestListener = protocolOnly): RequestListener {
  if (!route) return fallback;
  return (request, response) => {
    void route(request, response, trust).then((handled) => { if (!handled) fallback(request, response); }).catch(() => {
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"error":"internal_error"}');
    });
  };
}
