import { useState } from "react";

/**
 * The way in when no pairing link brought a token: the owner pastes the host
 * token by hand. There is no password, no account and no recovery; a pairing
 * link from Settings → Connections is the way for anyone else (ADR 0023).
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
        Open a pairing link: the host prints one when it starts, and Settings → Connections in a
        Tau window makes more. The host’s owner can also paste the host token — the single line
        in <code>~/.tau/host-token</code> on the machine running the host.
      </p>
      {notice ? <p className="token-gate-notice" role="alert">{notice}</p> : null}
      <label>
        <span>Token</span>
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
