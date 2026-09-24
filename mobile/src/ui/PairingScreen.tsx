import { formatVerification } from "../../../src/shared/pairing";

/**
 * While the host's owner decides: the digits to compare, like pairing a
 * Bluetooth device. Before the host has the request, which address is tried.
 */
export function PairingScreen({ hostName, verification, address, onCancel }: {
  hostName: string;
  verification?: string;
  /** "Local network", "Tailscale": how the phone reached the host. */
  address?: string;
  onCancel(): void;
}) {
  return <main className="shell-screen shell-pairing" aria-labelledby="pairing-title">
    <div className="shell-pairing-body" role="status" aria-live="polite">
      <h1 id="pairing-title">{verification ? `Waiting for ${hostName}` : `Reaching ${hostName}…`}</h1>
      {verification ? <>
        <p>Allow this phone on {hostName}. Its window shows a request with a code; allow it only if it is this one:</p>
        <output className="shell-code" aria-label="Pairing code">{formatVerification(verification)}</output>
      </> : <p>Trying every address the host gave, best first.</p>}
      {address ? <small>Over {address}</small> : null}
    </div>
    <div className="shell-actions">
      <button type="button" className="shell-secondary" onClick={onCancel}>Cancel</button>
    </div>
  </main>;
}
