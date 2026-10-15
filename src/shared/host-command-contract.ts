import { command } from "./host-command-definition.js";
import { HOST_FACTORY_COMMANDS } from "./host-factory-commands.js";
import { HOST_TURN_COMMANDS } from "./host-turn-commands.js";
import { HOST_CORE_COMMANDS } from "./host-core-commands.js";
import type { HostCommandArgs, HostCommandClient, HostCommandResult } from "./host-command-definition.js";
/** Installed by the process owning the listener, rather than the host adapter. */
export const HOST_TRANSPORT_COMMANDS = {
  "host.shutdown": command<{ stopping: boolean }>()({ access: "owner", decode: () => [] as const }),
};
export const HOST_COMMANDS = { ...HOST_FACTORY_COMMANDS, ...HOST_CORE_COMMANDS, ...HOST_TURN_COMMANDS, ...HOST_TRANSPORT_COMMANDS };
export type HostCommandName = keyof typeof HOST_COMMANDS;
export type CommandArgs<Name extends HostCommandName> = HostCommandArgs<(typeof HOST_COMMANDS)[Name]>;
export type CommandResult<Name extends HostCommandName> = HostCommandResult<(typeof HOST_COMMANDS)[Name]>;
export type CommandClient<Name extends HostCommandName> = HostCommandClient<(typeof HOST_COMMANDS)[Name]>;
