import { useState } from "react";
import type { DeviceAccess, UiPairingRequest } from "../../shared/connections";
import { formatVerification } from "../../shared/pairing";
import { Dialog } from "../components/ui/Dialog";
import { Button, SegmentedControl } from "../settings/controls";
import { describeDevice } from "../settings/connections-format";
import { DialogClose } from "./dialog-parts";
import { ACCESS_CHOICES, requestTitle } from "./pairing-format";
import "./pairing.css";

/** Full or Read only, with what the chosen one allows under it. */
export function AccessChoice({ value, disabled, onChange }: { value: DeviceAccess; disabled?: boolean; onChange(value: DeviceAccess): void }) {
  return (
    <div className="pairing-access">
      <SegmentedControl label="Access" value={value} disabled={disabled} options={ACCESS_CHOICES.map((choice) => ({ value: choice.value, label: choice.label }))} onChange={onChange} />
      <small>{ACCESS_CHOICES.find((choice) => choice.value === value)?.hint}</small>
    </div>
  );
}

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
      {request.companion ? (
        <p>Its agents come in too, as a second device “{request.companion.name}” with the same access, so they can work here while no window of it is open. Revoke either one alone later.</p>
      ) : null}
      <AccessChoice value={access} disabled={busy} onChange={setAccess} />
      <footer>
        <Button variant="danger" disabled={busy} onClick={onDeny}>Deny</Button>
        <Button variant="primary" busy={busy} onClick={() => onAllow(access)}>{busy ? "Allowing…" : "Allow"}</Button>
      </footer>
      <DialogClose label="Decide later" onClose={onClose} />
    </Dialog>
  );
}
