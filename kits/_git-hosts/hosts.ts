/** The Git hosts Tau knows by name; Review Kit's providers and the folder picker's marks share them. */
export type GitHostService = "github" | "gitlab" | "forgejo" | "bitbucket" | "azure-devops";
export const GIT_HOST_SERVICES: readonly GitHostService[] = ["github", "gitlab", "forgejo", "bitbucket", "azure-devops"];

export const GIT_HOST_LABELS: Readonly<Record<GitHostService, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  forgejo: "Forgejo",
  bitbucket: "Bitbucket",
  "azure-devops": "Azure DevOps",
};

/** The host a remote URL names, lower-cased with its port: `git@host:o/r`, `ssh://git@host:22/o/r`, `https://host/o/r`. */
export function remoteHost(remoteUrl: string | undefined): string | undefined {
  const value = remoteUrl?.trim();
  if (!value) return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)/u.exec(value);
    return scp?.[1]?.toLowerCase();
  }
  try {
    return new URL(value).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

const hasLabel = (hostname: string, label: string) => hostname.split(".").includes(label);

/** The provider a host is known to run, by its name alone; undefined for a name that says nothing. */
export function knownService(host: string): GitHostService | undefined {
  const hostname = host.replace(/:\d+$/u, "");
  if (hostname === "codeberg.org" || hasLabel(hostname, "forgejo") || hasLabel(hostname, "gitea")) return "forgejo";
  if (hostname === "github.com" || hasLabel(hostname, "github")) return "github";
  if (hostname === "gitlab.com" || hasLabel(hostname, "gitlab")) return "gitlab";
  // `ssh.dev.azure.com` and `vs-ssh.visualstudio.com` are the SSH hosts.
  if (hostname === "dev.azure.com" || hostname.endsWith(".dev.azure.com") || hostname.endsWith(".visualstudio.com")) return "azure-devops";
  if (hostname === "bitbucket.org" || hasLabel(hostname, "bitbucket")) return "bitbucket";
  return undefined;
}
