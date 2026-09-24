import { useState } from "react";
import { formatVerification } from "../shared/pairing";

/**
 * The way in when no pairing link brought a token: ask the host's owner to
 * let this device in, or, as the owner, paste the host token by hand. There
 * is no password, no account and no recovery (ADR 0023, ADR 0024).
 */
export function TokenGate({ notice, onSubmit, onAsk }: {
  notice?: string;
  onSubmit(token: string): void;
  /** Asks the owner without a link; the host shows the request with a code. */
  onAsk?(): void;
}) {
  const [value, setValue] = useState("");
  const token = value.trim();
  return <main className="token-gate">
    <form onSubmit={(event) => { event.preventDefault(); if (token) onSubmit(token); }}>
      <h1>Connect to a Tau host</h1>
      <p>
        Open a pairing link from Settings → Connections in a Tau window, or ask the host’s owner
        to let this device in. Either way the owner allows it on the host after comparing a code.
      </p>
      {notice ? <p className="token-gate-notice" role="alert">{notice}</p> : null}
      {onAsk ? <button type="button" className="token-gate-ask" onClick={onAsk}>Ask to connect</button> : null}
      <p>
        The host’s owner can also paste the host token — the single line in <code>~/.tau/host-token</code> on
        the machine running the host.
      </p>
      <label>
        <span>Host token</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-label="Token"
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button type="submit" disabled={!token}>Connect</button>
    </form>
  </main>;
}

/**
 * While the owner decides: the code this device shows, to compare with the
 * one on the host, like pairing a Bluetooth device.
 */
export function PairingWait({ verification, onCancel }: { verification?: string; onCancel(): void }) {
  return <main className="token-gate">
    <div className="token-gate-wait" role="status" aria-live="polite">
      <h1>Waiting for the host</h1>
      {verification ? <>
        <p>Allow this device on the host. Its window shows a request with a code; allow it only if it is this one:</p>
        <output className="token-gate-code" aria-label="Pairing code">{formatVerification(verification)}</output>
      </> : <p>Asking the host…</p>}
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </main>;
}
