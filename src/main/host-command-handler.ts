import type { HostCommand } from "../shared/host-command-definition.js";
import type { HostMethodContext } from "./host-jobs.js";

/** Decode once at the transport seam; implementations receive their declared tuple. */
export function bindHostCommand<Args extends readonly unknown[], Result, WireArgs extends readonly unknown[] | never>(
  definition: HostCommand<Args, Result, WireArgs>,
  handler: (args: NoInfer<Args>, context: HostMethodContext) => NoInfer<Result> | Promise<NoInfer<Result>>,
): (params: readonly unknown[], context: HostMethodContext) => Promise<Result> {
  return async (params, context) => handler(definition.decode(params), context);
}
