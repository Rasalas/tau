import { mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SignInAccount, SignInMethod } from "tau/host-extension";
import type { AntigravityAuthMethod, AuthorizationLink } from "./profile.js";

/**
 * How Antigravity signs in, after T3 Code's `authMethod`: a Google account
 * or Gemini Enterprise in the browser, or a key the agent reads from the
 * environment. Tau keeps the choice and the Google Cloud project, never a
 * credential: the agent stores its Google token in Tau's profile folder
 * itself, and a key stays in the user's shell environment.
 */
export interface AntigravitySignIn {
  method: AntigravityAuthMethod;
  gcpProject?: string;
  gcpLocation?: string;
}

const METHODS: ReadonlySet<string> = new Set(["oauth-personal", "oauth-business", "gemini-api-key", "agent-platform"]);
const GCP_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export const METHOD_LABELS: Record<AntigravityAuthMethod, string> = {
  "oauth-personal": "Google account",
  "oauth-business": "Gemini Enterprise",
  "gemini-api-key": "Gemini API key",
  "agent-platform": "Agent Platform (Vertex AI)",
};

export function usesBrowser(method: AntigravityAuthMethod): boolean {
  return method === "oauth-personal" || method === "oauth-business";
}

/** The choice in `<stateDir>/sign-in.json`; a missing or odd file is a Google account. */
export class AntigravitySignInSettings {
  private value: AntigravitySignIn = { method: "oauth-personal" };

  constructor(private readonly file: string) {
    try {
      this.value = decode(JSON.parse(readFileSync(file, "utf8")));
    } catch { /* nothing chosen yet */ }
  }

  get current(): AntigravitySignIn { return this.value; }

  async save(next: Partial<AntigravitySignIn>): Promise<AntigravitySignIn> {
    const merged = decode({ ...this.value, ...next });
    for (const [name, value] of [["project", next.gcpProject], ["location", next.gcpLocation]] as const) {
      if (value && !GCP_NAME.test(value.trim())) throw new Error(`“${value}” is no Google Cloud ${name} name.`);
    }
    mkdirSync(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
    this.value = merged;
    return merged;
  }
}

function decode(value: unknown): AntigravitySignIn {
  const item = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const text = (entry: unknown) => typeof entry === "string" && entry.trim() ? entry.trim() : undefined;
  const project = text(item.gcpProject);
  const location = text(item.gcpLocation);
  return {
    method: typeof item.method === "string" && METHODS.has(item.method) ? item.method as AntigravityAuthMethod : "oauth-personal",
    ...(project ? { gcpProject: project } : {}),
    ...(location ? { gcpLocation: location } : {}),
  };
}

/** The variables of the user's own environment that carry the chosen method's credential into the agent. */
export function credentialEnvironment(base: NodeJS.ProcessEnv, choice: AntigravitySignIn): Record<string, string> {
  const pick = (...names: string[]) => Object.fromEntries(names.flatMap((name) => base[name] ? [[name, base[name]!]] : []));
  if (choice.method === "gemini-api-key") return pick("GEMINI_API_KEY");
  // The agent prefers a key over the project pair, which reaches it through the profile's settings.
  if (choice.method === "agent-platform") return pick("GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS");
  return {};
}

/** Why a method cannot start yet; undefined when it can. */
export function methodProblem(method: AntigravityAuthMethod, choice: AntigravitySignIn, base: NodeJS.ProcessEnv): string | undefined {
  const project = Boolean(choice.gcpProject && choice.gcpLocation);
  if (method === "oauth-business" && !project) return "Set the Google Cloud project and location below first.";
  if (method === "gemini-api-key" && !base.GEMINI_API_KEY) return "Set GEMINI_API_KEY in your shell profile and restart Tau; Tau stores no key.";
  if (method === "agent-platform" && !base.GOOGLE_API_KEY && !project) return "Set GOOGLE_API_KEY in your shell profile, or a Google Cloud project and location below.";
  return undefined;
}

export function antigravitySignInMethods(choice: AntigravitySignIn, base: NodeJS.ProcessEnv, installed: string | undefined): SignInMethod[] {
  const methods: SignInMethod[] = [
    { id: "oauth-personal", label: "Sign in with Google", kind: "browser", description: "Your Google account's Antigravity plan, in the browser." },
    { id: "oauth-business", label: "Sign in with Gemini Enterprise", kind: "browser", description: "A Gemini Enterprise account, in the browser." },
    { id: "gemini-api-key", label: "Use a Gemini API key", kind: "api-key", description: "Billed per token; the agent reads GEMINI_API_KEY from your environment." },
    { id: "agent-platform", label: "Use Agent Platform (Vertex AI)", kind: "credentials", description: "Billed to your Google Cloud project; GOOGLE_API_KEY or your application default credentials." },
  ];
  return methods.map((method) => {
    const problem = installed ?? methodProblem(method.id as AntigravityAuthMethod, choice, base);
    return problem ? { ...method, unavailable: problem } : method;
  });
}

/** The account row for the chosen method: a token the agent stored, or a key in the environment. */
export function antigravityAccount(choice: AntigravitySignIn, tokenStored: boolean, base: NodeJS.ProcessEnv): SignInAccount {
  const label = METHOD_LABELS[choice.method];
  if (usesBrowser(choice.method)) {
    return tokenStored
      ? { signedIn: true, label, detail: choice.method === "oauth-business" ? `Project ${choice.gcpProject ?? "not set"}` : "Kept in Tau's Antigravity profile", canSignOut: true }
      : { signedIn: false };
  }
  const variable = choice.method === "gemini-api-key" ? "GEMINI_API_KEY" : base.GOOGLE_API_KEY ? "GOOGLE_API_KEY" : undefined;
  if (methodProblem(choice.method, choice, base)) return { signedIn: false, detail: `${label} is chosen but not set up.` };
  return { signedIn: true, label, detail: variable ? `${variable} from your environment` : `Project ${choice.gcpProject} · ${choice.gcpLocation}`, canSignOut: true };
}

/**
 * The address the browser was sent back to, pasted by a user whose browser
 * could not reach the agent's loopback page (a browser on another machine):
 * it must name the agent's own listener and the state the link carried.
 */
export function callbackAddress(pasted: string, link: AuthorizationLink): string {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new Error("That is not the address of the page Google sent you to.");
  }
  if (url.origin !== new URL(link.redirectUri).origin) throw new Error(`Paste the address that starts with ${link.redirectUri}.`);
  if (url.searchParams.get("state") !== link.state) throw new Error("That address belongs to another sign-in. Start again.");
  if (!url.searchParams.get("code") && !url.searchParams.get("error")) throw new Error("That address carries no answer from Google.");
  return url.toString();
}
