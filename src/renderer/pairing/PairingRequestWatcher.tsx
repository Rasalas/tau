import { Suspense, lazy, useEffect, useRef, useState } from "react";
import type { UiPairingRequest } from "../../shared/connections";
import { formatVerification } from "../../shared/pairing";
import { useHostClient } from "../host-client-context";
import { requestTitle } from "./pairing-format";

const LazyPairingRequestDialog = lazy(() => import("./PairingRequestDialog").then(({ PairingRequestDialog }) => ({ default: PairingRequestDialog })));

/** Not the owner, or a host that takes no other clients: nothing to watch. */
const NOT_OWNER = new Set(["forbidden", "unsupported", "unknown-method"]);

/**
 * Wherever the owner is in the window, a device asking to pair is asked
 * about at once, like a Bluetooth pairing prompt (ADR 0024). The hello says
 * whether this connection is the owner; from a host that does not say, a
 * paired client's window finds out on its first look and stops asking.
 */
export function PairingRequestWatcher({ onNotify }: { onNotify?(message: string): void }) {
  const client = useHostClient();
  const [requests, setRequests] = useState<UiPairingRequest[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const owner = useRef(true);
  const notified = useRef(new Set<string>());

  useEffect(() => {
    if (!client) return;
    const look = () => {
      if (!owner.current) return;
      if (client.isOwner?.() === false) { owner.current = false; return; }
      client.listConnections().then(
        (data) => setRequests(data.requests ?? []),
        (error: unknown) => {
          const code = (error as { code?: unknown } | undefined)?.code;
          if (typeof code === "string" && NOT_OWNER.has(code)) owner.current = false;
        },
      );
    };
    // A request already waiting when the window opened; after startup, not during it.
    const first = setTimeout(look, 1_500);
    const off = client.onHostEvent((event) => { if (event.type === "connections-changed") look(); });
    return () => { clearTimeout(first); off(); };
  }, [client]);

  useEffect(() => {
    for (const request of requests) {
      if (notified.current.has(request.id)) continue;
      notified.current.add(request.id);
      // The window may be behind another app; the OS says so, the dialog waits in the window.
      if (typeof document !== "undefined" && document.hasFocus()) continue;
      void client?.showNotification({
        title: `${requestTitle(request)} wants to connect`,
        body: `Code ${formatVerification(request.verification)}. Allow it in Tau only if the device shows the same code.`,
        tag: `tau-pairing-${request.id}`,
      }).catch(() => undefined);
    }
  }, [client, requests]);

  const request = requests.find((entry) => !dismissed.has(entry.id));
  if (!client || !request) return null;
  const settle = async (run: () => Promise<boolean>, gone: string) => {
    setBusy(true);
    try {
      if (!await run()) onNotify?.(gone);
    } catch (error: unknown) {
      onNotify?.(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setRequests((current) => current.filter((entry) => entry.id !== request.id));
    }
  };
  return <Suspense fallback={null}>
    <LazyPairingRequestDialog
      request={request}
      busy={busy}
      onAllow={(access) => void settle(async () => (await client.approvePairing(request.id, { access })).approved, "The device stopped waiting before it was allowed.")}
      onDeny={() => void settle(async () => (await client.denyPairing(request.id)).denied, "The request had already ended.")}
      onClose={() => setDismissed((current) => new Set(current).add(request.id))}
    />
  </Suspense>;
}
