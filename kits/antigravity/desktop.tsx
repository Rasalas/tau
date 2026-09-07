import { useEffect, useSyncExternalStore } from "react";
import { ExternalLink, Orbit } from "lucide-react";
import type { DesktopExtension, RegionProps } from "tau";
import { ANTIGRAVITY_BACKEND_KIND, ANTIGRAVITY_HOST_EXTENSION_ID, ANTIGRAVITY_SIGN_IN_EVENT, type AntigravitySignInEvent } from "./protocol.js";

/** The sign-in link the host half last reported; the status item opens it and offers it again. */
export class SignInLinks {
  private link?: { url: string; sequence: number };
  private sequence = 0;
  private readonly listeners = new Set<() => void>();
  getSnapshot = (): { url: string; sequence: number } | undefined => this.link;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  report(url: string): void {
    this.link = { url, sequence: ++this.sequence };
    for (const listener of this.listeners) listener();
  }
  clear(): void {
    this.link = undefined;
    for (const listener of this.listeners) listener();
  }
}

export const signInLinks = new SignInLinks();

function isGoogleSignIn(url: unknown): url is string {
  return typeof url === "string" && url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?");
}

/** Names the runtime behind an Antigravity thread, and opens Google's sign-in link when the agent asks for one. */
export function AntigravityStatus({ snapshot, actions }: RegionProps) {
  const link = useSyncExternalStore(signInLinks.subscribe, signInLinks.getSnapshot);
  // Every reported link is opened once; the button below re-opens it.
  useEffect(() => {
    if (!link) return;
    actions.openExternal(link.url);
    actions.notify("Sign in with Google in your browser to continue with Antigravity.");
  }, [actions, link?.sequence]);
  if (snapshot?.backendKind !== ANTIGRAVITY_BACKEND_KIND && !link) return null;
  const model = snapshot?.model?.name;
  return (
    <span className="status-item" title={`This thread runs Google's Antigravity agent through the Agent Client Protocol${model ? ` on ${model}` : ""}.`}>
      <Orbit size={12} /> Antigravity
      {link ? <button className="status-link" title="Open the Google sign-in link again" aria-label="Open the Google sign-in link" onClick={() => actions.openExternal(link.url)}><ExternalLink size={11} /> Sign in</button> : null}
    </span>
  );
}

/**
 * Antigravity's desktop half: marks its threads, and opens the Google sign-in
 * link the host half reports in the user's browser. Google redirects the
 * browser to the agent's own loopback listener; Tau never sees a token.
 */
export const antigravityExtension: DesktopExtension = {
  id: ANTIGRAVITY_HOST_EXTENSION_ID,
  name: "Antigravity",
  activate(plugin) {
    const stops = [
      plugin.registerStatusItem({ id: "antigravity.runtime", align: "left", order: 41, profiles: ["desktop", "web", "compact"], Component: AntigravityStatus }),
      plugin.host.onEvent(ANTIGRAVITY_SIGN_IN_EVENT, (payload) => {
        const event = payload as Partial<AntigravitySignInEvent> | undefined;
        if (isGoogleSignIn(event?.url)) signInLinks.report(event.url);
      }),
      plugin.events.on("agent-status", () => { /* a finished turn means the sign-in went through */ signInLinks.clear(); }),
    ];
    return () => { for (const stop of stops) stop(); };
  },
};

export default antigravityExtension;
