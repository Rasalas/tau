import { HostCommandError, type HostExtension, type HostExtensionContext } from "tau/host-extension";
import { join } from "node:path";
import { prepareScriptDocument } from "./document.js";
import { CUSTOMIZE_CHANGED_EVENT, CUSTOMIZE_COMMANDS, CUSTOMIZE_EXTENSION_ID, type ScriptOpen } from "./protocol.js";
import { CustomizeError, CustomizeStore } from "./store.js";

const DEFAULT_MAX_HEIGHT = 480;

function record(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new HostCommandError("The request is malformed.");
  return input as Record<string, unknown>;
}

/**
 * Customize Kit's host entry: the machine's customizations in the kit's state
 * folder, pushed to every client after a write, and a user script published
 * as a sandboxed frame for the client that draws it.
 */
export function createCustomizeHostExtension(): HostExtension {
  return {
    id: CUSTOMIZE_EXTENSION_ID,
    name: "Customize",
    permissions: ["network"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      const store = new CustomizeStore(join(services.stateDir, "customizations.json"));

      context.registerCommand(CUSTOMIZE_COMMANDS.get, () => store.get(), { access: "read" });

      context.registerCommand(CUSTOMIZE_COMMANDS.set, async (input) => {
        try {
          const state = await store.set(record(input).state);
          context.emit(CUSTOMIZE_CHANGED_EVENT, state);
          return state;
        } catch (error) {
          if (error instanceof CustomizeError) throw new HostCommandError(error.message);
          throw error;
        }
      });

      // Minting a frame changes nothing a device paired Read only could not see.
      context.registerCommand(CUSTOMIZE_COMMANDS.openScript, async (input): Promise<ScriptOpen> => {
        const call = record(input);
        const resources = services.browserResources;
        if (!resources) throw new HostCommandError("This machine serves no sandboxed frames.");
        const script = (await store.get()).scripts.find((entry) => entry.id === call.id);
        if (!script) return { state: "missing" };
        const path = resources.publishFrame({
          html: prepareScriptDocument(script.html, { theme: call.theme, inline: call.inline === true }),
          colorScheme: call.colorScheme === "dark" ? "dark" : "light",
        });
        return { state: "ready", path, maxHeight: script.maxHeight ?? DEFAULT_MAX_HEIGHT };
      }, { access: "read" });

      context.registerCommand(CUSTOMIZE_COMMANDS.release, (input) => {
        const call = record(input);
        if (typeof call.path === "string") services.browserResources?.release(call.path);
        return {};
      }, { access: "read" });
    },
  };
}

export default createCustomizeHostExtension;
