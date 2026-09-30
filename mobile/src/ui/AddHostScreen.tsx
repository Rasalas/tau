import { useEffect, useRef, useState } from "react";
import { ChevronLeft, QrCode } from "lucide-react";
import { parseMobilePairingPayload, type MobilePairingPayload } from "../relay-connect";

/** Why a pasted text is not something to pair with, in the words the field shows. */
export function pairingTextProblem(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const payload = parseMobilePairingPayload(trimmed);
  if (!payload) return "This is not a pairing link: it carries no code. Copy the whole link from Settings → Connections.";
  if (payload.endpoints.length === 0) return "This link names no address of the host. Create a new one on a host with Local network or Tailscale on.";
  return undefined;
}

/**
 * Adding a host: scan the QR code Settings → Connections shows, or paste its
 * link. Either way the host's owner then allows the phone after comparing
 * the digits.
 */
export function AddHostScreen({ error, initialText = "", onBack, onScan, onSubmit }: {
  error?: string;
  /** What was pasted before a failed attempt; a failure never throws the link away. */
  initialText?: string;
  onBack(): void;
  onScan(): void;
  onSubmit(payload: MobilePairingPayload, text: string): void;
}) {
  const [text, setText] = useState(initialText);
  const previousInitialText = useRef(initialText);
  useEffect(() => {
    if (previousInitialText.current === initialText) return;
    previousInitialText.current = initialText;
    setText(initialText);
  }, [initialText]);
  const problem = pairingTextProblem(text);
  const payload = text.trim() && !problem ? parseMobilePairingPayload(text) : undefined;
  return <main className="shell-screen" aria-labelledby="add-title">
    <header className="shell-header">
      <button type="button" className="shell-icon-button" aria-label="Back to hosts" onClick={onBack}><ChevronLeft size={24} /></button>
      <h1 id="add-title">Add host</h1>
    </header>
    <div className="shell-scroll shell-form">
      <p>On the computer running Tau, open Settings → Connections and create a pairing link. Scan its code, or paste the link here.</p>
      {error ? <p className="shell-notice" role="alert">{error}</p> : null}
      <button type="button" className="shell-primary" onClick={onScan}><QrCode size={20} />Scan QR code</button>
      <form onSubmit={(event) => { event.preventDefault(); if (payload) onSubmit(payload, text); }}>
        <label className="shell-field">
          <span>Pairing link</span>
          <textarea
            value={text}
            rows={3}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
            placeholder="https://…#pair=…"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? "pairing-text-problem" : undefined}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {problem ? <p id="pairing-text-problem" className="shell-field-error">{problem}</p> : null}
        <button type="submit" className="shell-primary" disabled={!payload}>Connect</button>
      </form>
    </div>
  </main>;
}
