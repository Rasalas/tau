const SCP_SOURCE = /^(?:[a-z0-9._-]+@)?[a-z0-9.-]+:[^\s]+$/iu;

/** Tau only accepts network Git sources advertised by the project picker. */
export function assertAllowedCloneSource(input: string): string {
  const source = input.trim();
  if (!source || source.includes("\0") || source.startsWith("-")) throw new Error("Enter a valid Git repository URL.");
  if (source.includes("://")) {
    try {
      const url = new URL(source);
      if ((url.protocol === "https:" || url.protocol === "ssh:") && url.hostname) return source;
    } catch {
      // Fall through to the stable user-facing error.
    }
  } else if (SCP_SOURCE.test(source)) {
    return source;
  }
  throw new Error("Use an HTTPS or SSH Git repository URL.");
}
