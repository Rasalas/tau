import { useState } from "react";

/**
 * The way in when the link did not bring a token: the operator pastes the line
 * from the host's `~/.tau/host-token`. It is deliberately the only alternative
 * — there is no password, no account and no recovery, because the token *is*
 * the authentication of a listening host (ADR 0010).
 */
export function TokenGate({ notice, onSubmit }: {
  notice?: string;
  onSubmit(token: string): void;
}) {
  const [value, setValue] = useState("");
  const token = value.trim();
  return <main className="token-gate">
    <form onSubmit={(event) => { event.preventDefault(); if (token) onSubmit(token); }}>
      <h1>Connect to a Tau host</h1>
      <p>
        Paste the host token — the single line in <code>~/.tau/host-token</code> on the machine
        running the host. Or open the pairing link the host printed when it started.
      </p>
      {notice ? <p className="token-gate-notice" role="alert">{notice}</p> : null}
      <label>
        <span>Host token</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-label="Host token"
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <button type="submit" disabled={!token}>Connect</button>
    </form>
  </main>;
}
