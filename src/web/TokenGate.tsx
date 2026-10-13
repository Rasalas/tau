import { useState } from "react";
import { formatVerification } from "../shared/pairing";
import "./web.css";

/**
 * The way in when no pairing link brought a token: ask the owner to let this
 * device in, or, as the owner, paste the access key (the host token). No file
 * path or console step appears here (ADR 0023, ADR 0024).
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
      <h1>Connect to Tau</h1>
      <p>In Tau on your computer, open Settings → Connections and choose Pair a device. Then open the link it makes in this browser.</p>
      {notice ? <p className="token-gate-notice" role="alert">{notice}</p> : null}
      {onAsk ? <div className="token-gate-request"><button type="button" className="token-gate-primary" onClick={onAsk}>Ask to connect</button><p>Tau on your computer shows a request with a code. Compare the codes, then allow it there.</p></div> : null}
      <div className="token-gate-entry">
        <label htmlFor="token-gate-token">{onConnect ? "Access key or Tau Connect link" : "Access key"}</label>
        <input id="token-gate-token" type="password" autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={value} onChange={(event) => setValue(event.target.value)} />
        <p>An access key is for whoever runs Tau on that computer. Everyone else {onAsk ? "asks to connect or opens a pairing link." : "opens a pairing link."}</p>
        <button type="submit" className={onAsk ? undefined : "token-gate-primary"} disabled={!token}>Connect</button>
      </div>
    </form>
  </main>;
}

/**
 * While the owner decides: the code this device shows, to compare with the
 * one on the computer, like pairing a Bluetooth device.
 */
export function PairingWait({ verification, onCancel }: { verification?: string; onCancel(): void }) {
  return <main className="token-gate">
    <div className="token-gate-wait" role="status" aria-live="polite">
      <img className="token-gate-mark" src="favicon.svg" alt="" />
      <h1>Waiting for your computer</h1>
      {verification ? <>
        <p>Compare the codes, then allow this browser in Tau on your computer.</p>
        <output className="token-gate-code" aria-label="Code to compare">{formatVerification(verification)}</output>
      </> : <p>Asking your computer…</p>}
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </main>;
}
