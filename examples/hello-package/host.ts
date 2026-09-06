import { Object as TObject, Optional, String as TString } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HostExtension, HostExtensionContext } from "tau/host-extension";

/**
 * The host half of the hello-package example. It registers one command the
 * desktop half calls (`greet`) and one Pi tool the agent can call
 * (`hello_tau`), both built on the same greeting.
 *
 * `registerRuntimeExtension` hands out a live Pi extension factory, which is
 * one of the members a worker cannot reach (see docs/EXTENSIONS.md and ADR
 * 0009's isolation table), so this package declares `"isolation":
 * "in-process"` in its manifest. A package that only needs `registerCommand`
 * and the plain-data services could stay in the default worker instead.
 */
function greet(name: string): string {
  return `Hello, ${name}! (from the hello-package example)`;
}

function nameFrom(input: unknown): string {
  const name = input && typeof input === "object" ? (input as { name?: unknown }).name : undefined;
  return typeof name === "string" && name.trim() ? name.trim() : "world";
}

const extension: HostExtension = {
  id: "example.hello-package",
  name: "Hello Package",
  activate(context: HostExtensionContext) {
    context.registerCommand("greet", (input) => ({ greeting: greet(nameFrom(input)) }));

    const unregisterTool = context.services.registerRuntimeExtension("example-hello-package", (pi: ExtensionAPI) => {
      pi.registerTool({
        name: "hello_tau",
        label: "Hello Tau",
        description: "Returns a friendly greeting. Call it to prove the hello-package example is installed and active.",
        promptSnippet: "hello_tau(name?) — a friendly greeting from the hello-package example",
        parameters: TObject({ name: Optional(TString({ description: "Who to greet; defaults to \"world\"." })) }),
        async execute(_toolCallId, params) {
          return { content: [{ type: "text", text: greet(params.name ?? "world") }], details: {} };
        },
      });
    });

    return () => { unregisterTool(); };
  },
};

export default extension;
