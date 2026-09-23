/**
 * Signing in to a runtime or a model provider from the window (API 1.12.0).
 * A kit's host half runs the flow its program offers and publishes where it
 * stands; the window draws that state and answers what it asks. The flow
 * never hands a credential back: whatever the user types goes to the program,
 * which keeps it where it always does.
 *
 * The host commands every kit that offers sign-in registers, with `target`
 * naming an instance or a provider (absent: the default one):
 * `sign-in-state` → `SignInReport`, `sign-in` `{ target, method }` →
 * `SignInFlowState`, `sign-in-respond` `{ target, flowId, value }`,
 * `sign-in-cancel` `{ target, flowId }` and `sign-out` `{ target }`; the
 * event `sign-in` carries `SignInEvent`. `registerSignIn` on
 * `tau/host-extension` registers all of them.
 */

export const SIGN_IN_EVENT = "sign-in";
export const SIGN_IN_COMMANDS = {
  state: "sign-in-state",
  start: "sign-in",
  respond: "sign-in-respond",
  cancel: "sign-in-cancel",
  signOut: "sign-out",
} as const;

/** How a method signs in, which decides what the window offers before it starts. */
export type SignInMethodKind = "browser" | "device-code" | "api-key" | "terminal" | "credentials";

export interface SignInMethod {
  id: string;
  label: string;
  description?: string;
  kind: SignInMethodKind;
  /** Why it cannot start now ("Set GEMINI_API_KEY first"); the window shows it instead of a button. */
  unavailable?: string;
}

export interface SignInAccount {
  signedIn: boolean;
  /** Who or what: an email, a plan, "API key". */
  label?: string;
  /** Where it comes from: "ChatGPT Pro", "ANTHROPIC_API_KEY". */
  detail?: string;
  /** Sign-out removes what the program stored; absent when there is nothing to remove (an environment variable). */
  canSignOut?: boolean;
}

export type SignInPhase = "starting" | "waiting" | "verifying" | "succeeded" | "failed" | "cancelled";

/** A question the flow waits on; `select` answers with an option id. */
export interface SignInPrompt {
  id: string;
  kind: "text" | "secret" | "select" | "code";
  message: string;
  placeholder?: string;
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>;
}

export interface SignInFlowState {
  flowId: string;
  method: string;
  phase: SignInPhase;
  /** The provider's consent page, to open in a browser. */
  browser?: { url: string; instructions?: string };
  /** A code to enter at `url` on any device. */
  deviceCode?: { url: string; code: string; expiresAt?: number };
  /** A command the window runs in a terminal the user sees; answered with its exit status. */
  terminal?: { command: string };
  prompt?: SignInPrompt;
  message?: string;
  links?: ReadonlyArray<{ url: string; label?: string }>;
  /** When the flow gives up by itself, ms since the epoch. */
  expiresAt?: number;
}

export interface SignInReport {
  methods: SignInMethod[];
  account?: SignInAccount;
  /** The flow in progress or the one that just ended; absent when none ran. */
  flow?: SignInFlowState;
  /** One line about where the credential lives. */
  note?: string;
}

/** A flow that moved carries `flow`; a finished flow or a sign-out carries the whole `report`. */
export interface SignInEvent {
  target: string;
  flow?: SignInFlowState;
  report?: SignInReport;
}

/** Whether a flow still wants something from the user or the program. */
export function signInActive(flow: SignInFlowState | undefined): boolean {
  return flow?.phase === "starting" || flow?.phase === "waiting" || flow?.phase === "verifying";
}

/** Single-quoted for a POSIX shell, or for PowerShell, which quotes the same way apart from escaping. */
export function shellQuote(value: string, platform: string = "posix"): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return platform === "win32" ? `'${value.replace(/'/gu, "''")}'` : `'${value.replace(/'/gu, `'"'"'`)}'`;
}

/** A command line with variables set for it: `NAME=value cmd args` in a POSIX shell, `$env:` assignments in PowerShell. */
export function commandLine(executable: string, args: readonly string[], env: Readonly<Record<string, string>> = {}, platform: string = "posix"): string {
  const words = [executable, ...args].map((word) => shellQuote(word, platform));
  if (platform === "win32") {
    const set = Object.entries(env).map(([name, value]) => `$env:${name}=${shellQuote(value, platform)}; `).join("");
    return `${set}& ${words.join(" ")}`;
  }
  const set = Object.entries(env).map(([name, value]) => `${name}=${shellQuote(value)} `).join("");
  return `${set}${words.join(" ")}`;
}
