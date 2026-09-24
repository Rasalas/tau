import { useState } from "react";
import type { DeviceAccess, UiPairingRequest } from "../../shared/connections";
import { formatVerification } from "../../shared/pairing";
import { Dialog } from "../components/ui/Dialog";
import { describeDevice } from "../settings/connections-format";
import { ACCESS_CHOICES, requestTitle } from "./pairing-format";
import "./pairing.css";

/**
 * "<device> wants to connect": the owner compares the code with the one on
 * the device, picks what it may do, and allows or denies it (ADR 0024).
 * Closing it leaves the request waiting in Settings → Connections.
 */
export function PairingRequestDialog({ request, busy, onAllow, onDeny, onClose }: {
  request: UiPairingRequest;
  busy?: boolean;
  onAllow(access: DeviceAccess): void;
  onDeny(): void;
  onClose(): void;
}) {
  const [access, setAccess] = useState<DeviceAccess>(request.access);
  const details = [describeDevice(request.device), request.address,
    request.link ? `with the link${request.link.label ? ` “${request.link.label}”` : ""}` : "without a pairing link"].filter(Boolean);
  return (
    <Dialog className="confirm-dialog pairing-request" label={`${requestTitle(request)} wants to connect`} onClose={onClose}>
      <h2>{requestTitle(request)} wants to connect</h2>
      <p>{details.join(" · ")}</p>
      <output className="pairing-code" aria-label="Pairing code">{formatVerification(request.verification)}</output>
      <p>Allow it only if the device shows this code. A device you let in can use this machine as you can, within what you pick below.</p>
      <div className="segmented pairing-access" role="group" aria-label="Access">
        {ACCESS_CHOICES.map((choice) => (
          <button key={choice.value} type="button" title={choice.hint} className={choice.value === access ? "active" : ""} aria-pressed={choice.value === access} onClick={() => setAccess(choice.value)}>
            {choice.label}
          </button>
        ))}
      </div>
      <footer>
        <button type="button" className="danger" disabled={busy} onClick={onDeny}>Deny</button>
        <button type="button" className="primary" disabled={busy} onClick={() => onAllow(access)}>{busy ? "Allowing…" : "Allow"}</button>
      </footer>
    </Dialog>
  );
}
