import { formatVerification } from "../../../src/shared/pairing";

/**
 * While the owner decides on the computer: the digits to compare, like
 * pairing a Bluetooth device. Before the computer has the request, which
 * address is tried.
 */
export function PairingScreen({ hostName, verification, address, onCancel }: {
  hostName: string;
  verification?: string;
  /** "Local network", "Tailscale": how the phone reached the computer. */
  address?: string;
  onCancel(): void;
}) {
  return <main className="shell-screen shell-pairing" aria-labelledby="pairing-title">
    <div className="shell-pairing-body" role="status" aria-live="polite">
      <h1 id="pairing-title">{verification ? `Waiting for ${hostName}` : `Reaching ${hostName}…`}</h1>
      {verification ? <>
        <p>Allow this phone in Tau on {hostName}. It shows a request with a code. Allow it only if the code is this one:</p>
        <output className="shell-code" aria-label="Code to compare">{formatVerification(verification)}</output>
      </> : <p>Trying every way to reach it, best first.</p>}
      {address ? <small>Over {address}</small> : null}
    </div>
    <div className="shell-actions">
      <button type="button" className="shell-secondary" onClick={onCancel}>Cancel</button>
    </div>
  </main>;
}
