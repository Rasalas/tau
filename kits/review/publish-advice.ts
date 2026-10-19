/** `git@host:owner/repo.git` and `https://host/owner/repo.git` for the same repository; undefined for any other shape. */
export function otherProtocolUrl(url: string): string | undefined {
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/u.exec(url);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/u.exec(url);
  return https ? `git@${https[1]}:${https[2]}` : undefined;
}

const isSsh = (url: string): boolean => /^(?:ssh:\/\/)?git@/u.test(url);

/** Git's own words can carry a URL with credentials; none of them are repeated. */
const redact = (text: string): string => text.replace(/(\w+:\/\/)[^\s/@]+@/gu, "$1");

/**
 * Says why the first push of a just-published repository failed and what to do, from git's output and
 * the remote's URL. The repository exists by then, so publishing again cannot help.
 */
export function pushAdvice(output: string, remote: { name: string; url: string }): string {
  const other = otherProtocolUrl(remote.url);
  const switchTo = (protocol: "HTTPS" | "SSH") => other ? ` or switch the remote to ${protocol} with "git remote set-url ${remote.name} ${other}",` : "";
  if (/Host key verification failed/iu.test(output)) {
    return `The host's SSH key is not trusted yet. Connect once with ssh to verify it,${switchTo("HTTPS")} then push again.`;
  }
  if (isSsh(remote.url) && /Permission denied \(publickey|Permission to .+ denied|publickey/iu.test(output)) {
    return `SSH authentication was rejected. Add an SSH key to your account,${switchTo("HTTPS")} then push again.`;
  }
  if (!isSsh(remote.url) && /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|returned error: 40[13]|HTTP 40[13]/iu.test(output)) {
    return `Git could not sign in over HTTPS. Check your Git credentials,${switchTo("SSH")} then push again.`;
  }
  const reason = redact(output.split(/\r?\n/u).find((line) => line.trim() && !line.startsWith("Command failed:"))?.trim() ?? "");
  return `${reason ? `${/[.!?]$/u.test(reason) ? reason : `${reason}.`} ` : ""}Fix the problem, then push again.`;
}
