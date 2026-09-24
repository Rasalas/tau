export const TAILSCALE_EXTENSION_ID = "tau.tailscale";

/** Serve's HTTPS port when the user picks none: the URL then carries no port. */
export const DEFAULT_HTTPS_PORT = 443;

/** Where the admin console lets the owner rename a machine and turn on HTTPS certificates. */
export const ADMIN_MACHINES_URL = "https://login.tailscale.com/admin/machines";
export const ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";
export const HTTPS_DOCS_URL = "https://tailscale.com/kb/1153/enabling-https";
export const DOWNLOAD_URL = "https://tailscale.com/download";

/**
 * How far this machine is from Tailscale HTTPS: no host listeners of its own,
 * no CLI, Tailscale not connected or signed out, or running.
 */
export type TailscaleState = "no-host-network" | "not-installed" | "not-running" | "needs-login" | "running";

/** A path Serve forwards on one HTTPS port that is not Tau's. */
export interface ServeOther {
  httpsPort: number;
  path: string;
  target: string;
}

export interface TailscaleView {
  state: TailscaleState;
  /** `BackendState` as the CLI said it, for a state Tau does not name. */
  backendState?: string;
  /** This machine's MagicDNS name, `<machine>.<tailnet>.ts.net`, without the trailing dot. */
  dnsName?: string;
  /** Whether the tailnet has MagicDNS on. */
  magicDns: boolean;
  /** Whether the tailnet has HTTPS certificates on for this machine (`CertDomains`). */
  https: boolean;
  /** Tau's loopback proxy listener, where Serve forwards to. */
  proxyPort: number;
  proxyListening: boolean;
  serve: {
    /** Serve forwards `url` to Tau's proxy listener. */
    on: boolean;
    httpsPort: number;
    url?: string;
    /** What else Serve forwards on this machine, so a port is not taken over. */
    others: ServeOther[];
  };
  /** Something the user should read: why a step failed, or what changed outside Tau. */
  notice?: string;
  platform: string;
}

export interface TailscaleCommands {
  status: { input: undefined; output: TailscaleView };
  "serve-on": { input: { httpsPort: number; name: string }; output: TailscaleView };
  "serve-off": { input: undefined; output: TailscaleView };
}

/** `https://name/`, or `https://name:port/` off 443. */
export function serveUrl(dnsName: string, httpsPort: number): string {
  return `https://${dnsName}${httpsPort === DEFAULT_HTTPS_PORT ? "" : `:${httpsPort}`}/`;
}
