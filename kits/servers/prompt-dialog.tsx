import { useState, useSyncExternalStore, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Dialog, errorMessage, hostIsReadOnly } from "tau";
import type { DesktopExtensionContext } from "tau";
import { SERVERS_PROMPTS_EVENT, decodeServerPrompts, type ServerPrompt, type ServerPromptAnswer } from "./protocol.js";

/** The host half's open questions, as its event and `prompts` command report them. */
export class ServerPromptFeed {
  private prompts: ServerPrompt[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly context: DesktopExtensionContext) {}

  start(): () => void {
    const stop = this.context.host.onEvent(SERVERS_PROMPTS_EVENT, (payload) => this.set(decodeServerPrompts(payload)));
    void this.context.host.invoke("prompts").then((payload) => this.set(decodeServerPrompts(payload)), () => undefined);
    return stop;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get = () => this.prompts;

  answer(id: string, answer: ServerPromptAnswer): Promise<unknown> {
    return this.context.host.invoke("answer-prompt", { id, ...answer });
  }

  private set(prompts: ServerPrompt[]): void {
    this.prompts = prompts;
    for (const listener of this.listeners) listener();
  }
}

function PromptDialog({ prompt, feed }: { prompt: ServerPrompt; feed: ServerPromptFeed }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = (answer: ServerPromptAnswer) => {
    setBusy(true);
    setError(undefined);
    feed.answer(prompt.id, answer).catch((failure: unknown) => { setError(errorMessage(failure)); setBusy(false); });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (prompt.kind === "secret" && !value) return;
    send(prompt.kind === "secret" ? { action: "confirm", value } : { action: "confirm" });
    setValue("");
  };
  return createPortal(
    <Dialog className="confirm-dialog servers-prompt" label={prompt.title} onClose={() => { if (!busy) send({ action: "cancel" }); }}>
      <form onSubmit={submit}>
        <header>
          <h2>{prompt.title}</h2>
          <p>{prompt.message}</p>
        </header>
        {prompt.detail ? <pre className="servers-prompt-detail">{prompt.detail}</pre> : null}
        {prompt.kind === "secret" ? (
          <input
            type="password"
            aria-label={prompt.field ?? "Password"}
            placeholder={prompt.field ?? "Password"}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            disabled={busy}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : null}
        {error ? <p className="servers-prompt-error" role="alert">{error}</p> : null}
        <footer>
          {prompt.alternativeLabel ? <button type="button" className="servers-prompt-alternative" disabled={busy} onClick={() => send({ action: "alternative" })}>{prompt.alternativeLabel}</button> : null}
          <button type="button" disabled={busy} onClick={() => send({ action: "cancel" })}>{prompt.cancelLabel ?? "Cancel"}</button>
          <button type="submit" className="primary" disabled={busy || (prompt.kind === "secret" && !value)}>{prompt.confirmLabel}</button>
        </footer>
      </form>
    </Dialog>,
    document.body,
  );
}

/** Draws the oldest open question; a Read-only device cannot answer, so it draws none. */
export function createServerPromptLayer(feed: ServerPromptFeed) {
  return function ServerPromptLayer() {
    const prompts = useSyncExternalStore(feed.subscribe, feed.get);
    const prompt = prompts[0];
    if (!prompt || hostIsReadOnly()) return null;
    return <PromptDialog key={prompt.id} prompt={prompt} feed={feed} />;
  };
}
