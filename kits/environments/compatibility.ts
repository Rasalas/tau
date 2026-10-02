import { ENVIRONMENTS_EXTENSION_ID } from "./protocol.js";

export type MachineOperation = "take messages from here" | "start threads" | "rename threads from here" | "take images from here" | "change models from here";

function updateError(error: unknown, machine: string, operation: MachineOperation): Error {
  const code = (error as { code?: unknown } | null)?.code;
  return Object.assign(new Error(`${machine} runs an older Tau that cannot ${operation} yet. Update ${machine} in Settings → Machines.`, { cause: error }), { code, expected: true });
}

/** A missing machine method, unlike a runtime/permission/connection failure, asks for an update. */
export function machineMethodError(error: unknown, machine: string, operation: MachineOperation): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "unknown-method" ? updateError(error, machine, operation) : error;
}

/** The same for a command of this kit on that machine; hosts before `unknown-command` answer `failed` with these sentences. */
export function machineCommandError(error: unknown, machine: string, command: string, operation: MachineOperation): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  const missing = code === "unknown-method" || code === "unknown-extension" || code === "unknown-command"
    || code === "failed" && (message === `Host extension Machines has no command "${command}".` || message === `Host extension ${ENVIRONMENTS_EXTENSION_ID} is not installed.`);
  return missing ? updateError(error, machine, operation) : error;
}
