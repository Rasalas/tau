import { describe, expect, it, vi } from "vitest";
import { HOST_FACTORY_COMMANDS } from "../shared/host-factory-commands.js";
import type { HostCommandClient } from "../shared/host-command-definition.js";
import { bindHostCommand } from "./host-command-handler.js";
import { NO_JOB_CONTEXT } from "./host-jobs.js";

function checkFactoryTypes() {
  const preferences: HostCommandClient<typeof HOST_FACTORY_COMMANDS["environments-set-preferences"]> = async () => {};
  void preferences({});
  void preferences({ reopenShown: true });
  // @ts-expect-error The preference is a boolean on the wire.
  void preferences({ reopenShown: "yes" });
  // @ts-expect-error A settings handler must return the declared configuration, not a string.
  bindHostCommand(HOST_FACTORY_COMMANDS["environments-update-config"], async () => "invalid");
  // @ts-expect-error A blob index is numeric after decoding.
  bindHostCommand(HOST_FACTORY_COMMANDS["blob-put"], async (args: readonly [string, string, string]) => ({ received: args[1].length }));
}
void checkFactoryTypes;

describe("factory host command contracts", () => {
  it("keeps permissive service options and validates required environment preferences", () => {
    expect(HOST_FACTORY_COMMANDS["service-install"].decode([])).toEqual([{}]);
    expect(HOST_FACTORY_COMMANDS["service-install"].decode([{ display: "ignored" }])).toEqual([{}]);
    expect(HOST_FACTORY_COMMANDS["service-install"].decode([{ display: false }])).toEqual([{ display: false }]);
    expect(() => HOST_FACTORY_COMMANDS["environments-set-preferences"].decode([{}]))
      .toThrow("environments-set-preferences: reopenShown must be a boolean.");
  });

  it("validates blob integrity fields before invoking its typed implementation", async () => {
    const commit = vi.fn(async ([id, sha256, size]: readonly [string, string, number]) => ({ id, sha256, size }));
    const method = bindHostCommand(HOST_FACTORY_COMMANDS["blob-commit"], commit);
    await expect(method(["upload", "invalid", 8], NO_JOB_CONTEXT)).rejects.toThrow("blob-commit: sha256 is 64 hex digits.");
    expect(commit).not.toHaveBeenCalled();
    const sha256 = "a".repeat(64);
    await expect(method(["upload", sha256, 8], NO_JOB_CONTEXT)).resolves.toEqual({ id: "upload", sha256, size: 8 });
  });

  it("keeps extension payloads opaque while validating their destination and timeout", () => {
    const payload = { custom: [1, null, { nested: true }] };
    const command = HOST_FACTORY_COMMANDS["environments-extension-invoke"];
    expect(command.decode(["machine", "tau.test", "command", payload])[3]).toBe(payload);
    expect(() => command.decode(["machine", "tau.test", "command", payload, { timeoutMs: 0 }]))
      .toThrow("environments-extension-invoke: options must contain a positive timeoutMs.");
    expect(() => command.decode(["machine", "", "command", payload])).toThrow("extensionId must be a non-empty string");
  });

  it("retains file-transfer audit privacy and owner-only connection management", () => {
    expect(HOST_FACTORY_COMMANDS["blob-put"].audit).toEqual({ label: "sent part of a file", automatic: true, quiet: true });
    expect(HOST_FACTORY_COMMANDS["connections-host-token"].access).toBe("owner");
    expect(HOST_FACTORY_COMMANDS["service-status"].access).toBe("read");
  });
});
