import { useState } from "react";
import { formatVerification } from "../shared/pairing";

/**
 * The way in when no pairing link brought a token: ask the host's owner to
 * let this device in, or, as the owner, paste the host token by hand. There
 * is no password, no account and no recovery (ADR 0023, ADR 0024).
 */
export function TokenGate({ notice, onSubmit, onAsk, onConnect }: {
  notice?: string;
  onSubmit(token: string): void;
  /** Asks the owner without a link; the host shows the request with a code. */
  onAsk?(): void;
  onConnect?(link: string): void;
}) {
  const [value, setValue] = useState("");
  const token = value.trim();
  return <main className="token-gate">
    <form onSubmit={(event) => { event.preventDefault(); if (token) { if (onConnect && token.startsWith("tau-connect:")) onConnect(token); else onSubmit(token); } }}>
      <img className="token-gate-mark" src="favicon.svg" alt="" />
      <h1>Connect to a Tau host</h1>
      <p>Create a pairing link in Tau’s Settings → Connections.</p>
      {notice ? <p className="token-gate-notice" role="alert">{notice}</p> : null}
      {onAsk ? <div className="token-gate-request"><button type="button" className="token-gate-primary" onClick={onAsk}>Ask to connect</button><p>Compare the codes, then allow the request on the host.</p></div> : null}
      <div className="token-gate-entry">
        <div className="token-gate-field-label"><label htmlFor="token-gate-token">{onConnect ? "Host token or Tau Connect link" : "Host token"}</label><details className="token-gate-help"><summary aria-label="Where to find the host token" /><p>Find the host token in <code>~/.tau/host-token</code> on the host.</p></details></div>
        <input id="token-gate-token" aria-label="Token" type="password" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} />
        <button type="submit" className={onAsk ? undefined : "token-gate-primary"} disabled={!token}>Connect</button>
      </div>
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
      <img className="token-gate-mark" src="favicon.svg" alt="" />
      <h1>Waiting for the host</h1>
      {verification ? <>
        <p>Compare the codes, then allow the request on the host.</p>
        <output className="token-gate-code" aria-label="Pairing code">{formatVerification(verification)}</output>
      </> : <p>Asking the host…</p>}
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </main>;
}
