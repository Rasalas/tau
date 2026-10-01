/** A missing machine method, unlike a runtime/permission/connection failure, asks for an update. */
export function machineMethodError(error: unknown, machine: string, operation: "take messages from here" | "start threads"): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== "unknown-method") return error;
  return Object.assign(new Error(`${machine} runs an older Tau that cannot ${operation} yet. Update ${machine} in Settings → Machines.`, { cause: error }), { code, expected: true });
}
