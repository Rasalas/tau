/**
 * Limits on what a project's agent commands may reach (API 1.14.0). Kits
 * provide rules per project folder; core merges them to the strictest and hands
 * the result to whoever runs commands. Core enforces nothing itself and knows
 * no reason for a limit: that is the providing kit's sentence.
 */

/** `any`: no limit. `loopback`: this machine only, plus `allowHosts`. */
export type HostNetworkReach = "any" | "loopback";

/** One provider's answer for a project folder. */
export interface HostExecutionPolicyRule {
  network: HostNetworkReach;
  /** With `loopback`: hosts reachable anyway, `example.com` or `*.example.com` (subdomains only). */
  allowHosts?: readonly string[];
  /** One sentence for the user: why the limit holds and where it is lifted. */
  reason?: string;
}

/** Every provider's rules for a folder, merged: the strictest wins. */
export interface HostExecutionPolicy {
  network: HostNetworkReach;
  /** Hosts every limiting provider allows; empty with `any`. */
  allowHosts: readonly string[];
  /** The limiting providers' sentences, in registration order. */
  reasons: readonly string[];
  /** The extensions whose rules limit the folder. */
  sources: readonly string[];
}

export type HostExecutionPolicyProvider = (cwd: string) => HostExecutionPolicyRule | undefined | Promise<HostExecutionPolicyRule | undefined>;

/** Word that a provider's answer changed; `cwd` when it knows for which folder. */
export interface HostExecutionPolicyChange {
  source: string;
  cwd?: string;
}

export interface HostExecutionPolicyServices {
  /** This extension's rules; a second call replaces the first. Returns the withdrawal. */
  provide(provider: HostExecutionPolicyProvider): () => void;
  /** Tells the readers that this extension's answer changed, for one folder or for all. */
  changed(cwd?: string): void;
  /** The merged policy for a folder, asked fresh each time. */
  for(cwd: string): Promise<HostExecutionPolicy>;
  observe(listener: (change: HostExecutionPolicyChange) => void): () => void;
}

export const UNLIMITED_EXECUTION_POLICY: HostExecutionPolicy = Object.freeze({ network: "any", allowHosts: [], reasons: [], sources: [] });

const HOST_PATTERN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** A host name or `*.domain`, lower-cased; undefined for anything else (a URL, a port, a bare `*`). */
export function normalizeAllowedHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const host = value.trim().toLowerCase().replace(/\.$/u, "");
  return host.length <= 253 && HOST_PATTERN.test(host) ? host : undefined;
}

/**
 * The strictest of several rules: `loopback` when any rule says so, and only
 * the hosts every limiting rule allows.
 */
export function mergeExecutionPolicies(rules: ReadonlyArray<{ source: string; rule: HostExecutionPolicyRule }>): HostExecutionPolicy {
  const limiting = rules.filter(({ rule }) => rule.network !== "any");
  if (limiting.length === 0) return UNLIMITED_EXECUTION_POLICY;
  const lists = limiting.map(({ rule }) => new Set((rule.allowHosts ?? []).flatMap((host) => normalizeAllowedHost(host) ?? [])));
  const [first, ...rest] = lists;
  const allowHosts = [...first!].filter((host) => rest.every((list) => list.has(host))).sort();
  return {
    network: "loopback",
    allowHosts,
    reasons: limiting.flatMap(({ rule }) => (rule.reason?.trim() ? [rule.reason.trim()] : [])),
    sources: [...new Set(limiting.map(({ source }) => source))],
  };
}

/**
 * Why a runtime that cannot hold its commands to `policy` refuses a prompt;
 * undefined when nothing limits the folder.
 */
export function executionPolicyRefusal(policy: HostExecutionPolicy | undefined, runtime: string): string | undefined {
  if (!policy || policy.network === "any") return undefined;
  const why = policy.reasons.length ? `${policy.reasons.join(" ")} ` : "An extension limits this project's commands to this machine's network. ";
  return `${why}${runtime} cannot enforce that limit, so it does not run here. Lift the limit for this project, or use a runtime that enforces it.`;
}

/**
 * Who limits which project. A provider that throws limits the folder to
 * loopback with no hosts: a limit that cannot be read is not lifted.
 */
export class ExecutionPolicyRegistry {
  private readonly providers = new Map<string, HostExecutionPolicyProvider>();

  private readonly observers = new Set<(change: HostExecutionPolicyChange) => void>();

  private readonly bound = new Map<string, HostExecutionPolicyServices>();

  constructor(private readonly log: (label: string, detail?: string) => void = () => undefined) {}

  /** The facade one extension sees: its `provide` and `changed` speak for its own id only. */
  forExtension(source: string): HostExecutionPolicyServices {
    let facade = this.bound.get(source);
    if (facade) return facade;
    facade = {
      provide: (provider) => {
        this.providers.set(source, provider);
        this.notify({ source });
        return () => {
          if (this.providers.get(source) !== provider) return;
          this.providers.delete(source);
          this.notify({ source });
        };
      },
      changed: (cwd) => this.notify({ source, ...(cwd ? { cwd } : {}) }),
      for: (cwd) => this.for(cwd),
      observe: (listener) => {
        this.observers.add(listener);
        return () => { this.observers.delete(listener); };
      },
    };
    this.bound.set(source, facade);
    return facade;
  }

  async for(cwd: string): Promise<HostExecutionPolicy> {
    const rules = await Promise.all([...this.providers].map(async ([source, provider]) => {
      try {
        const rule = await provider(cwd);
        return rule && (rule.network === "any" || rule.network === "loopback") ? [{ source, rule }] : [];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log("execution-policy.provider-failed", `${source}: ${message}`);
        return [{ source, rule: { network: "loopback" as const, reason: `${source} could not say what this project may reach (${message}).` } }];
      }
    }));
    return mergeExecutionPolicies(rules.flat());
  }

  private notify(change: HostExecutionPolicyChange): void {
    for (const observer of [...this.observers]) {
      try {
        observer(change);
      } catch (error) {
        this.log("execution-policy.observer-failed", error instanceof Error ? error.message : String(error));
      }
    }
  }
}
